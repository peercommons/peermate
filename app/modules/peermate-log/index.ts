import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class PeermateLogModule extends NativeModule {
  log(message: string): void;
}

const native = requireOptionalNativeModule<PeermateLogModule>('PeermateLog');

const format = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Field-test log line. Android: logcat (`adb logcat -s ReactNativeJS`). iOS: the
 * unified log, subsystem com.peermate.app (app/tools/ios-log.sh), since Release
 * builds there drop console output.
 */
export function appLog(tag: string, ...args: unknown[]): void {
  if (native) native.log(`[${tag}] ${args.map(format).join(' ')}`);
  else console.info(`[${tag}]`, ...args);
}
