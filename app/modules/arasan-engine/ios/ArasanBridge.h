#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs Arasan inside the app and speaks UCI with it over pipes.
@interface ArasanBridge : NSObject

/// Starts the engine once per process (later calls only replace `onLine`).
/// `programPath` stands in for the executable's path (argv[0]).
+ (void)startWithProgramPath:(NSString *)programPath onLine:(void (^)(NSString *line))onLine;

/// Writes one UCI command line to the engine.
+ (void)send:(NSString *)command;

@end

NS_ASSUME_NONNULL_END
