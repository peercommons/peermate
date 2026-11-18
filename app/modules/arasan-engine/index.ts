import { NativeModule, requireOptionalNativeModule } from 'expo';

type ArasanEngineEvents = {
  onLine(event: { line: string }): void;
};

declare class ArasanEngineModule extends NativeModule<ArasanEngineEvents> {
  /** Starts the engine (a child process on Android, in process on iOS); resolves with the network file path. */
  start(): Promise<string>;
  /** Writes one UCI command line to the engine. */
  send(command: string): void;
  stop(): void;
}

// Null where the module isn't built (e.g. a build made before native/build-arasan-*.sh ran).
export default requireOptionalNativeModule<ArasanEngineModule>('ArasanEngine');
