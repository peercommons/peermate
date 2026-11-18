import { NativeModule, requireOptionalNativeModule } from 'expo';

type ArasanEngineEvents = {
  onLine(event: { line: string }): void;
};

declare class ArasanEngineModule extends NativeModule<ArasanEngineEvents> {
  /** Starts the engine process; resolves with the network file path. */
  start(): Promise<string>;
  /** Writes one UCI command line to the engine. */
  send(command: string): void;
  stop(): void;
}

// Android only for now: iOS can't run the engine as a child process, so it needs
// an in-process build (SPECS §5.1). Null where the module isn't available.
export default requireOptionalNativeModule<ArasanEngineModule>('ArasanEngine');
