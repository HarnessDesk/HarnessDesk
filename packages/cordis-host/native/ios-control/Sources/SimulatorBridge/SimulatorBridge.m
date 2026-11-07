/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Adapted simulator XPC endpoint and DTUHID wire setup from idb, MIT.
 * See licenses/MIT-idb.txt and THIRD_PARTY_NOTICES.md for the pinned source.
 */
#import "SimulatorBridge.h"
#import <objc/message.h>
#import <dlfcn.h>
#import <xpc/xpc.h>
#import <CoreGraphics/CoreGraphics.h>
#import <signal.h>
static volatile sig_atomic_t inputCancelled = 0;
static void cancelInput(int signalNumber) { inputCancelled = 1; }
void HDInstallCancellationHandlers(void) { signal(SIGTERM, cancelInput); signal(SIGINT, cancelInput); }
int HDInputCancelled(void) { return inputCancelled != 0; }
static NSString *const service = @"com.apple.coredevice.feature.remote.hid.digitizer";
static NSError *failure(NSString *message) { return [NSError errorWithDomain:@"app.harnessdesk.ios" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; }
BOOL HDProbeXcode(NSString *directory, NSError **error) {
    BOOL core = NO, kit = NO;
    for (NSString *path in @[@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", [directory stringByAppendingPathComponent:@"Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"]]) if (dlopen(path.UTF8String, RTLD_NOW|RTLD_GLOBAL)) { core = YES; break; }
    for (NSString *path in @[[directory stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"], [[directory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"]]) if (dlopen(path.UTF8String, RTLD_NOW|RTLD_GLOBAL)) { kit = YES; break; }
    void *symbols = dlopen(NULL, RTLD_NOW);
    BOOL hid = symbols && dlsym(symbols, "xpc_endpoint_create_mach_port_4sim") && dlsym(symbols, "xpc_connection_enable_sim2host_4sim");
    if (symbols) dlclose(symbols);
    if (core && kit && hid && NSClassFromString(@"SimServiceContext")) return YES;
    *error = failure(@"The selected Xcode simulator input frameworks or symbols could not be loaded."); return NO;
}
static BOOL selector(id object, NSString *name, NSError **error) {
    if (object && [object respondsToSelector:NSSelectorFromString(name)]) return YES;
    if (error) *error = failure([NSString stringWithFormat:@"The installed Xcode is missing the simulator input selector %@.", name]);
    return NO;
}
static id get(id obj, NSString *name) { return ((id(*)(id,SEL))objc_msgSend)(obj, NSSelectorFromString(name)); }
static xpc_object_t encode(id value) {
    if ([value isKindOfClass:NSDictionary.class]) {
        xpc_object_t out = xpc_dictionary_create(NULL, NULL, 0);
        for (NSString *key in value) xpc_dictionary_set_value(out, key.UTF8String, encode(value[key]));
        return out;
    }
    if ([value isKindOfClass:NSString.class]) return xpc_string_create([value UTF8String]);
    if ([value isKindOfClass:NSNumber.class]) {
        if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return xpc_bool_create([value boolValue]);
        if (strcmp([value objCType], @encode(double)) == 0 || strcmp([value objCType], @encode(float)) == 0) return xpc_double_create([value doubleValue]);
        return xpc_uint64_create([value unsignedLongLongValue]);
    }
    return xpc_null_create();
}
BOOL HDUsesUsKeyboard(NSDictionary *preferences, NSDictionary *global) {
    NSArray *keyboards = preferences[@"KeyboardsCurrentAndNext"];
    NSString *current = [keyboards isKindOfClass:NSArray.class] && keyboards.count ? keyboards[0] : nil;
    if ([current isKindOfClass:NSString.class] && ([current isEqualToString:@"en_US@sw=QWERTY;hw=Automatic"] || [current isEqualToString:@"en_US@sw=QWERTY;hw=US"])) return YES;
    id configured = global[@"AppleKeyboards"];
    BOOL unconfigured = preferences[@"KeyboardsCurrentAndNext"] == nil &&
        (configured == nil || ([configured isKindOfClass:NSArray.class] && [configured count] == 0));
    return unconfigured && [global[@"AppleLocale"] isEqual:@"en_US"];
}
@implementation HDSimulatorConnection {
    id _device;
    NSString *_udid;
    NSString *_developerDirectory;
    xpc_connection_t _connection;
    dispatch_queue_t _queue;
    BOOL _invalidated;
    double _pixelWidth;
    double _pixelHeight;
}
+ (NSDictionary *)pointerPosition {
    CGEventRef event = CGEventCreate(NULL); CGPoint point = CGEventGetLocation(event); CFRelease(event);
    return @{@"x":@(point.x), @"y":@(point.y)};
}
@synthesize pixelWidth = _pixelWidth, pixelHeight = _pixelHeight;
- (instancetype)initWithDeveloperDirectory:(NSString *)directory udid:(NSString *)udid error:(NSError **)error {
    self = [super init];
    if (!self) return nil;
    @try {
        NSArray *paths = @[@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", [directory stringByAppendingPathComponent:@"Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"]];
        BOOL loaded = NO;
        for (NSString *path in paths) if (dlopen(path.UTF8String, RTLD_NOW|RTLD_GLOBAL)) { loaded = YES; break; }
        if (!loaded) { *error = failure(@"iOS Simulator control requires a full Xcode installation."); return nil; }
        // Xcode has shipped SimulatorKit in both locations. It is not a fallback transport.
        for (NSString *path in @[[directory stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"], [[directory stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"]]) if (dlopen(path.UTF8String, RTLD_NOW|RTLD_GLOBAL)) break;
        id cls = NSClassFromString(@"SimServiceContext");
        if (!selector(cls, @"sharedServiceContextForDeveloperDir:error:", error)) return nil;
        id context = ((id(*)(id,SEL,id,NSError **))objc_msgSend)(cls, NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), directory, error);
        if (!selector(context, @"defaultDeviceSetWithError:", error)) return nil;
        id set = ((id(*)(id,SEL,NSError **))objc_msgSend)(context, NSSelectorFromString(@"defaultDeviceSetWithError:"), error);
        if (!selector(set, @"devices", error)) return nil;
        id device = nil;
        for (id candidate in get(set, @"devices")) {
            if (!selector(candidate, @"UDID", error)) return nil;
            if ([[get(candidate, @"UDID") UUIDString] caseInsensitiveCompare:udid] == NSOrderedSame) { device = candidate; break; }
        }
        if (!device) { *error = failure(@"The requested simulator was not found."); return nil; }
        _device = device; _udid = udid; _developerDirectory = directory;
        if (!selector(device, @"state", error)) return nil;
        if (((NSUInteger(*)(id,SEL))objc_msgSend)(device, NSSelectorFromString(@"state")) != 3) { *error = failure(@"The requested simulator is not booted."); return nil; }
        if (!selector(device, @"deviceType", error)) return nil;
        id type = get(device, @"deviceType");
        if (!selector(type, @"mainScreenSize", error)) return nil;
        CGSize size = ((CGSize(*)(id,SEL))objc_msgSend)(type, NSSelectorFromString(@"mainScreenSize"));
        _pixelWidth = size.width; _pixelHeight = size.height;
        void *symbols = dlopen(NULL, RTLD_NOW);
        xpc_endpoint_t (*endpointCreate)(mach_port_t, uint64_t, uint64_t) = dlsym(symbols, "xpc_endpoint_create_mach_port_4sim");
        void (*enable)(xpc_connection_t) = dlsym(symbols, "xpc_connection_enable_sim2host_4sim");
        dlclose(symbols);
        if (!endpointCreate || !enable) { *error = failure(@"The installed Xcode is missing the simulator input XPC symbols."); return nil; }
        if (!selector(device, @"lookup:error:", error)) return nil;
        mach_port_t port = ((mach_port_t(*)(id,SEL,id,NSError **))objc_msgSend)(device, NSSelectorFromString(@"lookup:error:"), service, error);
        if (!port) return nil;
        xpc_endpoint_t endpoint = endpointCreate(port, 0, 0);
        if (!endpoint) { *error = failure(@"The simulator input endpoint could not be created."); return nil; }
        _connection = xpc_connection_create_from_endpoint(endpoint);
        if (!_connection) { *error = failure(@"The simulator input connection could not be created."); return nil; }
        enable(_connection);
        _queue = dispatch_queue_create("app.harnessdesk.ios.input", DISPATCH_QUEUE_SERIAL);
        xpc_connection_set_target_queue(_connection, _queue);
        __weak HDSimulatorConnection *weakSelf = self;
        xpc_connection_set_event_handler(_connection, ^(xpc_object_t event) {
            HDSimulatorConnection *strongSelf = weakSelf;
            if (strongSelf && xpc_get_type(event) == XPC_TYPE_ERROR) { @synchronized(strongSelf) { strongSelf->_invalidated = YES; } }
        });
        xpc_connection_resume(_connection);
        if (![self sendPayload:@{@"usageCode":@0, @"state":@2} messageType:@"IndigoKeyboardButtonEvent" barrier:YES waitForAcknowledgement:YES error:error]) { [self close]; return nil; }
        [NSThread sleepForTimeInterval:0.2];
        return self;
    } @catch (NSException *exception) {
        *error = failure(@"The installed Xcode simulator input interface is incompatible.");
        return nil;
    }
}
- (BOOL)sendPayload:(NSDictionary *)payload messageType:(NSString *)messageType barrier:(BOOL)barrier waitForAcknowledgement:(BOOL)wait error:(NSError **)error {
    @synchronized(self) { if (!_connection || _invalidated) { *error = failure(@"The simulator input connection was interrupted; the gesture was stopped."); return NO; } }
    xpc_object_t message = encode(@{@"messageType":messageType, @"featureIdentifier":service, @"isBarrier":@(barrier), @"payload":payload});
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL ok = YES;
    if (!wait) {
        // Queue the release and give the local XPC sender a bounded drain. No guest acknowledgement.
        xpc_connection_send_message(_connection, message);
        xpc_connection_send_barrier(_connection, ^{ dispatch_semaphore_signal(done); });
        dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 100*NSEC_PER_MSEC));
        return YES;
    }
    if (barrier) {
        xpc_connection_send_message_with_reply(_connection, message, _queue, ^(xpc_object_t reply) {
            ok = xpc_get_type(reply) != XPC_TYPE_ERROR;
            dispatch_semaphore_signal(done);
        });
    } else {
        xpc_connection_send_message(_connection, message);
        xpc_connection_send_barrier(_connection, ^{ dispatch_semaphore_signal(done); });
    }
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 4;
    BOOL answered = NO;
    while (!HDInputCancelled() && NSProcessInfo.processInfo.systemUptime < deadline) {
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10*NSEC_PER_MSEC)) == 0) { answered = YES; break; }
    }
    if (!answered || !ok) {
        *error = failure(@"DTUHID did not answer the simulator input liveness round trip."); return NO;
    }
    return YES;
}
- (BOOL)verifyRotation:(NSInteger)rotation error:(NSError **)error {
    // Observe immediately before dispatch, after the helper's queue and DTUHID liveness wait.
    NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"];
    task.arguments = @[@"simctl", @"io", _udid, @"enumerate"];
    NSMutableDictionary *environment = NSProcessInfo.processInfo.environment.mutableCopy;
    environment[@"DEVELOPER_DIR"] = _developerDirectory; task.environment = environment;
    NSPipe *output = [NSPipe pipe]; task.standardOutput = output; task.standardError = [NSFileHandle fileHandleWithNullDevice];
    if (![task launchAndReturnError:error]) return NO;
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 5;
    while (task.running && NSProcessInfo.processInfo.systemUptime < deadline && !HDInputCancelled()) [NSThread sleepForTimeInterval:0.01];
    if (task.running) {
        [task terminate];
        NSTimeInterval stopDeadline = NSProcessInfo.processInfo.systemUptime + 0.2;
        while (task.running && NSProcessInfo.processInfo.systemUptime < stopDeadline) [NSThread sleepForTimeInterval:0.01];
        if (task.running) kill(task.processIdentifier, SIGKILL);
        [task waitUntilExit];
        *error = failure(@"The simulator display observation timed out or was cancelled."); return NO;
    }
    [task waitUntilExit];
    NSData *bytes = [output.fileHandleForReading readDataToEndOfFile];
    NSString *text = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
    NSArray *sections = [text componentsSeparatedByString:@"Screen Type: Integrated"];
    NSString *screen = sections.count > 1 ? [[sections[1] componentsSeparatedByString:@"Screen Type:"] firstObject] : @"";
    NSArray *orientations = [screen componentsSeparatedByString:@"UI Orientation:"];
    NSString *orientation = orientations.count > 1 ? orientations[1] : @"";
    orientation = [[orientation componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] firstObject];
    orientation = [[orientation stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString stringByReplacingOccurrencesOfString:@" " withString:@""];
    NSNumber *observed = @{@"portrait":@0, @"landscaperight":@1, @"portraitupsidedown":@2, @"landscapeleft":@3}[orientation ?: @""];
    if (task.terminationStatus != 0 || !observed || observed.integerValue != rotation) {
        *error = failure(@"The simulator display geometry changed or could not be observed; capture a fresh frame."); return NO;
    }
    return YES;
}
- (BOOL)verifyUsKeyboardWithError:(NSError **)error {
    if (!selector(_device, @"dataPath", error)) return NO;
    NSString *dataPath = get(_device, @"dataPath");
    if (![dataPath isKindOfClass:NSString.class]) { *error = failure(@"The simulator keyboard layout could not be observed."); return NO; }
    NSDictionary *preferences = [NSDictionary dictionaryWithContentsOfURL:[NSURL fileURLWithPath:[dataPath stringByAppendingPathComponent:@"Library/Preferences/com.apple.keyboard.preferences.plist"]] error:nil];
    NSDictionary *global = [NSDictionary dictionaryWithContentsOfURL:[NSURL fileURLWithPath:[dataPath stringByAppendingPathComponent:@"Library/Preferences/.GlobalPreferences.plist"]] error:nil];
    if (HDUsesUsKeyboard(preferences ?: @{}, global ?: @{})) return YES;
    *error = failure(@"Text input requires an observed US QWERTY simulator keyboard; other or unknown layouts are not yet supported.");
    return NO;
}
- (void)close { @synchronized(self) { _invalidated = YES; if (_connection) { xpc_connection_cancel(_connection); _connection = nil; } } }
- (void)dealloc { [self close]; }
@end
