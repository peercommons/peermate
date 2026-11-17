import { NativeModule, requireNativeModule } from 'expo';

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

export default requireNativeModule<ArasanEngineModule>('ArasanEngine');
