import {ConfigurationFile, IStack} from '../common/interfaces';
import HeapSnapshotParser from './heap_snapshot_parser';
import {HeapGrowthTracker, HeapGraph, toPathTree} from './growth_graph';
import StackFrameConverter from './stack_frame_converter';
import ChromeDriver from './chrome_driver';
import {configureProxy} from '../common/util';
import {writeFileSync} from 'fs';
import LeakRoot from './leak_root';
import BLeakResults from './bleak_results';

const DEFAULT_CONFIG: ConfigurationFile = {
  name: "unknown",
  iterations: 4,
  url: "http://localhost:8080/",
  fixedLeaks: [],
  leaks: {},
  blackBox: [],
  login: [],
  setup: [],
  loop: [],
  timeout: 999999999,
  rewrite: (url, type, data, fixes) => data
};
const DEFAULT_CONFIG_STRING = JSON.stringify(DEFAULT_CONFIG);
type StepType = "login" | "setup" | "loop";

function wait(d: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, d);
  });
}

function getConfigFromSource(configSource: string): ConfigurationFile {
  const m = {exports: Object.assign({}, DEFAULT_CONFIG) };
  // CommonJS emulation
  new Function('exports', 'module', configSource)(m.exports, m);
  return m.exports;
}

function getConfigBrowserInjection(configSource: string): string {
  // CommonJS emulation
  return `(function() {
  var module = { exports: ${DEFAULT_CONFIG_STRING} };
  var exports = module.exports;
  ${configSource}
  window.BLeakConfig = module.exports;
})();`;
}

function defaultSnapshotCb(): Promise<void> {
  return Promise.resolve();
}

export class BLeakDetector {
  /**
   * Find leaks in an application.
   * @param configSource The source code of the configuration file as a CommonJS module.
   * @param proxy The proxy instance that relays connections from the webpage.
   * @param driver The application driver.
   */
  public static async FindLeaks(configSource: string, driver: ChromeDriver, snapshotCb: (sn: HeapSnapshotParser) => Promise<void> = defaultSnapshotCb): Promise<BLeakResults> {
    const detector = new BLeakDetector(driver, configSource, snapshotCb);
    return detector.findAndDiagnoseLeaks();
  }

  /**
   * Evaluate the effectiveness of leak fixes. Runs the application without any of the fixes,
   * and then with each fix in successive order. Outputs a CSV report to the `log` function.
   * @param configSource The source code of the configuration file as a CommonJS module.
   * @param driver The browser driver.
   * @param iterations Number of loop iterations to perform.
   * @param iterationsPerSnapshot Number of loop iterations to perform before each snapshot.
   * @param log Log function. Used to write a report. Assumes each call to `log` appends a newline.
   * @param snapshotCb (Optional) Snapshot callback.
   */
  public static async EvaluateLeakFixes(configSource: string, driver: ChromeDriver, iterations: number, iterationsPerSnapshot: number, log: (s: string) => void, snapshotCb: (sn: HeapSnapshotParser, metric: string, leaksFixed: number, iteration: number) => Promise<void> = defaultSnapshotCb, resumeAt?: [number, string]): Promise<void> {
    const detector = new BLeakDetector(driver, configSource);
    return detector.evaluateLeakFixes(iterations, iterationsPerSnapshot, log, snapshotCb, resumeAt);
  }

  private _driver: ChromeDriver;
  private readonly _configSource: string;
  private readonly _config: ConfigurationFile;
  private readonly _growthTracker = new HeapGrowthTracker();
  private _leakRoots: LeakRoot[] = [];
  private _snapshotCb: (sn: HeapSnapshotParser) => Promise<void>;
  private readonly _configInject: string;
  private constructor(driver: ChromeDriver, configSource: string, snapshotCb: (sn: HeapSnapshotParser) => Promise<void> = defaultSnapshotCb) {
    this._driver = driver;
    this._configSource = configSource;
    this._config = getConfigFromSource(configSource);
    this._snapshotCb = snapshotCb;
    this._configInject = getConfigBrowserInjection(configSource);
    this.configureProxy(false, []);
  }

  public configureProxy(rewriteJavaScript: boolean, fixes: number[], disableAllRewrites: boolean = false, useConfigRewrite: boolean = false): void {
    return configureProxy(this._driver.mitmProxy, rewriteJavaScript, fixes, this._configInject, disableAllRewrites, useConfigRewrite ? this._config.rewrite : undefined);
  }

  public takeSnapshot(): HeapSnapshotParser {
    const sn = this._driver.takeHeapSnapshot();
    try {
      this._snapshotCb(sn);
    } catch (e) {
      console.log(`Snapshot callback exception:`);
      console.log(e);
    }
    return sn;
  }

  /**
   * Execute the given configuration.
   * @param iterations Number of loops to perform.
   * @param login Whether or not to run the login steps.
   * @param runGc Whether or not to run the GC before taking a snapshot.
   * @param takeSnapshotFunction If set, takes snapshots after every loop and passes it to the given callback.
   */
  private async _execute(iterations: number, login: boolean, takeSnapshotFunction: (sn: HeapSnapshotParser) => Promise<void | undefined> = undefined, iterationsPerSnapshot: number = 1, snapshotOnFirst = false): Promise<void> {
    await this._driver.navigateTo(this._config.url);
    if (login) {
      await this._runLoop(false, 'login', false);
      await wait(1000);
      await this._driver.navigateTo(this._config.url);
    }
    await this._runLoop(false, 'setup', false);
    if (takeSnapshotFunction !== undefined && snapshotOnFirst) {
      // Wait for page to load.
      await this._waitUntilTrue(0, 'loop');
      await takeSnapshotFunction(this.takeSnapshot());
    }
    for (let i = 0; i < iterations; i++) {
      const snapshotRun = takeSnapshotFunction !== undefined && (((i + 1) % iterationsPerSnapshot) === 0);
      const sn = await this._runLoop(<true> snapshotRun, 'loop', true);
      if (snapshotRun) {
        await takeSnapshotFunction(sn);
      }
    }
  }

  /**
   * Runs the webpage in an uninstrumented state to locate growing paths in the heap.
   */
  public async findLeakPaths(): Promise<LeakRoot[]> {
    this.configureProxy(false, this._config.fixedLeaks, undefined, true);
    await this._execute(this._config.iterations, true, (sn) => this._growthTracker.addSnapshot(sn));
    const leakRoots = this._leakRoots = this._growthTracker.findLeakPaths();
    return leakRoots;
  }

  /**
   * Locates memory leaks on the page and diagnoses them. This is the end-to-end
   * BLeak algorithm.
   */
  public async findAndDiagnoseLeaks(): Promise<BLeakResults> {
    return this.diagnoseLeaks(await this.findLeakPaths());
  }

  /**
   * Given a set of leak roots (accessible from multiple paths), runs the webpage in an
   * instrumented state that collects stack traces as the objects at the roots grow.
   * @param leakRoots
   */
  public async diagnoseLeaks(leakRoots: LeakRoot[]): Promise<BLeakResults> {
    const results = new BLeakResults(leakRoots);
    // TODO: Change all of these file writes to debug log writes!!!
    console.log(`Growing paths:\n${JSON.stringify(toPathTree(leakRoots))}`);
    writeFileSync('leaks.json', Buffer.from(JSON.stringify(toPathTree(leakRoots)), 'utf8'));
    // We now have all needed closure modifications ready.
    // Run once.
    if (leakRoots.length > 0) {
      writeFileSync('paths.json', JSON.stringify(toPathTree(leakRoots)));
      console.log("Going to diagnose now...");
      // Flip on JS instrumentation.
      this.configureProxy(true, this._config.fixedLeaks, undefined, true);
      await this._execute(1, false)
      console.log("Instrumenting growth paths...");
      // Instrument objects to push information to global array.
      await this._instrumentGrowingObjects();
      await this._runLoop(false, 'loop', true);
      await this._runLoop(false, 'loop', true);
      // Fetch array as string.
      const growthStacks = await this._getGrowthStacks(results);
      this._leakRoots.forEach((lr) => {
        const index = lr.id;
        const stacks = growthStacks[index] || [];
        stacks.forEach((s) => {
          lr.addStackTrace(s);
        });
      });
    } else {
      console.log(`No leak roots found!`);
    }
    // GC the results.
    return results.compact();
  }

  public async evaluateLeakFixes(iterations: number, iterationsPerSnapshot: number, log: (s: string) => void, snapshotCb: (ss: HeapSnapshotParser, metric: string, leaksFixed: number, iteration: number) => Promise<void>, resumeAt?: [number, string]): Promise<void> {
    let metrics = Object.keys(this._config.leaks);
    let headerPrinted = !!resumeAt;
    let iterationCount = 0;
    let leaksFixed = resumeAt ? resumeAt[0] : 0;
    let metric: string;

    let logBuffer = new Array<string>();
    function stageLog(l: string): void {
      logBuffer.push(l);
    }

    function flushLog(): void {
      for (const msg of logBuffer) {
        log(msg);
      }
      logBuffer = [];
    }

    function emptyLog(): void {
      logBuffer = [];
    }

    async function snapshotReport(sn: HeapSnapshotParser): Promise<void> {
      const g = await HeapGraph.Construct(sn);
      const size = g.calculateSize();
      const data = Object.assign({ metric, leaksFixed, iterationCount }, size);
      const keys = Object.keys(data).sort();
      if (!headerPrinted) {
        log(keys.join(","));
        headerPrinted = true;
      }
      stageLog(keys.map((k) => (<any> data)[k]).join(","));
      iterationCount++;
    }

    const executeWrapper = async (iterations: number, login: boolean, takeSnapshots?: (sn: HeapSnapshotParser) => Promise<void>, iterationsPerSnapshot?: number, snapshotOnFirst?: boolean): Promise<void> => {
      while (true) {
        try {
          iterationCount = 0;
          await this._execute(iterations, login, takeSnapshots, iterationsPerSnapshot, snapshotOnFirst);
          flushLog();
          return;
        } catch (e) {
          console.log(e);
          console.log(`Timed out. Trying again.`);
          emptyLog();
          this._driver = await this._driver.relaunch();
        }
      }
    };

    // Disable fixes for base case.
    this.configureProxy(false, [], true, true);

    this._snapshotCb = function(ss) {
      return snapshotCb(ss, metric, leaksFixed, iterationCount);
    };

    let hasResumed = false;
    for (metric of metrics) {
      if (resumeAt && !hasResumed) {
        hasResumed = metric === resumeAt[1];
        if (!hasResumed) {
          continue;
        }
      }
      const leaks = this._config.leaks[metric];
      for (leaksFixed = resumeAt && metric === resumeAt[1] ? resumeAt[0] : 0; leaksFixed <= leaks.length; leaksFixed++) {
        this.configureProxy(false, leaks.slice(0, leaksFixed), true, true);
        await executeWrapper(iterations, true, snapshotReport, iterationsPerSnapshot, true);
        this._driver = await this._driver.relaunch();
      }
    }
    await this._driver.shutdown();
  }

  private async _waitUntilTrue(i: number, prop: StepType, timeoutDuration: number = this._config.timeout): Promise<void> {
    let timeoutOccurred = false;
    let timeout = setTimeout(() => timeoutOccurred = true, timeoutDuration);

    if (this._config[prop][i].sleep) {
      await wait(this._config[prop][i].sleep);
    }

    while (true) {
      try {
        const success = await this._driver.runCode<boolean>(`typeof(BLeakConfig) !== "undefined" && BLeakConfig.${prop}[${i}].check()`);
        if (success) {
          clearTimeout(timeout);
          // Delay before returning to give browser time to "catch up".
          await wait(500); // 5000
          return;
        } else if (timeoutOccurred) {
          throw new Error(`Timed out.`);
        }
      } catch (e) {
        console.error(`Exception encountered when running ${prop}[${i}].check(): ${e}`);
      }
      await wait(100); // 1000
    }
  }

  private async _nextStep(i: number, prop: StepType): Promise<void> {
    await this._waitUntilTrue(i, prop);
    return this._driver.runCode<void>(`BLeakConfig.${prop}[${i}].next()`);
  }

  private _runLoop(snapshotAtEnd: false, prop: StepType, isLoop: boolean): Promise<void>;
  private _runLoop(snapshotAtEnd: true, prop: StepType, isLoop: boolean): Promise<HeapSnapshotParser>;
  private async _runLoop(snapshotAtEnd: boolean, prop: StepType, isLoop: boolean): Promise<HeapSnapshotParser | void> {
    const numSteps: number = (<any> this._config)[prop].length;
    // let promise: Promise<string | void> = Promise.resolve();
    if (numSteps > 0) {
      for (let i = 0; i < numSteps; i++) {
        try {
          await this._nextStep(i, prop);
        } catch (e) {
          console.error(`Exception encountered when running ${prop}[${i}].next(): ${e}`);
          throw e;
        }
      }
      if (isLoop) {
        // Wait for loop to finish.
        await this._waitUntilTrue(0, prop);
      }
      if (snapshotAtEnd) {
        return this.takeSnapshot();
      }
    }
  }

  /**
   * Instruments the objects at the growth paths so they record stack traces whenever they expand.
   * @param ps
   */
  private _instrumentGrowingObjects(): Promise<void> {
    return this._driver.runCode<void>(`window.$$$INSTRUMENT_PATHS$$$(${JSON.stringify(toPathTree(this._leakRoots))})`);
  }

  /**
   * Returns all of the stack traces associated with growing objects.
   */
  private async _getGrowthStacks(results: BLeakResults): Promise<{[id: number]: IStack[]}> {
    const traces = await this._driver.runCode<GrowingStackTraces>(`window.$$$GET_STACK_TRACES$$$()`);
    return StackFrameConverter.ConvertGrowthStacks(this._driver.mitmProxy, this._config.url, results, traces);
  }
}

export default BLeakDetector;