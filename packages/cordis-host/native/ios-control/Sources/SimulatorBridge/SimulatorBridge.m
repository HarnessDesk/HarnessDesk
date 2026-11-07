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
static NSString *const service = @"com.apple.coredevice.feature.remote.hid.digitizer";
static NSError *failure(NSString *message) { return [NSError errorWithDomain:@"app.harnessdesk.ios" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; }
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
@implementation HDSimulatorConnection {
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
        if (![self sendPayload:@{@"usageCode":@0, @"state":@2} messageType:@"IndigoKeyboardButtonEvent" barrier:YES error:error]) { [self close]; return nil; }
        [NSThread sleepForTimeInterval:0.2];
        return self;
    } @catch (NSException *exception) {
        *error = failure(@"The installed Xcode simulator input interface is incompatible.");
        return nil;
    }
}
- (BOOL)sendPayload:(NSDictionary *)payload messageType:(NSString *)messageType barrier:(BOOL)barrier error:(NSError **)error {
    @synchronized(self) { if (!_connection || _invalidated) { *error = failure(@"The simulator input connection was interrupted; the gesture was stopped."); return NO; } }
    xpc_object_t message = encode(@{@"messageType":messageType, @"featureIdentifier":service, @"isBarrier":@(barrier), @"payload":payload});
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block BOOL ok = YES;
    if (barrier) {
        xpc_connection_send_message_with_reply(_connection, message, _queue, ^(xpc_object_t reply) {
            ok = xpc_get_type(reply) != XPC_TYPE_ERROR;
            dispatch_semaphore_signal(done);
        });
    } else {
        xpc_connection_send_message(_connection, message);
        xpc_connection_send_barrier(_connection, ^{ dispatch_semaphore_signal(done); });
    }
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 4*NSEC_PER_SEC)) != 0 || !ok) {
        *error = failure(@"DTUHID did not answer the simulator input liveness round trip."); return NO;
    }
    return YES;
}
- (void)close { @synchronized(self) { _invalidated = YES; if (_connection) { xpc_connection_cancel(_connection); _connection = nil; } } }
- (void)dealloc { [self close]; }
@end
