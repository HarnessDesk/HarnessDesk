#import <Foundation/Foundation.h>
void HDInstallCancellationHandlers(void);
int HDInputCancelled(void);
NS_ASSUME_NONNULL_BEGIN
@interface HDSimulatorConnection : NSObject
+ (NSDictionary *)pointerPosition;
@property(nonatomic, readonly) double pixelWidth;
@property(nonatomic, readonly) double pixelHeight;
- (nullable instancetype)initWithDeveloperDirectory:(NSString *)directory udid:(NSString *)udid error:(NSError **)error;
- (BOOL)sendPayload:(NSDictionary *)payload messageType:(NSString *)messageType barrier:(BOOL)barrier error:(NSError **)error;
- (BOOL)verifyUsKeyboardWithError:(NSError **)error;
- (void)close;
@end
NS_ASSUME_NONNULL_END
