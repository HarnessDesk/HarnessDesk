import UIKit
final class ReceiptView: UIView {
    var record: ([String: Any]) -> Void = { _ in }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { log("began", touches, event) }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { log("moved", touches, event) }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { log("ended", touches, event) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { log("cancelled", touches, event) }
    private func log(_ phase: String, _ touches: Set<UITouch>, _ event: UIEvent?) {
        record(["kind":"touch", "phase":phase, "contacts":(event?.allTouches ?? touches).map { ["x":$0.location(in:self).x,"y":$0.location(in:self).y] }])
    }
}
final class Controller: UIViewController, UITextFieldDelegate {
    let field = UITextField()
    let label = UILabel()
    var receipts: [[String: Any]] = []
    override func loadView() {
        let canvas = ReceiptView(); canvas.backgroundColor = .white; canvas.isMultipleTouchEnabled = true
        canvas.record = { [weak self] in self?.record($0) }; view = canvas
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        field.frame = CGRect(x:30,y:150,width:330,height:60); field.borderStyle = .roundedRect; field.placeholder = "Synthetic input fixture"; field.delegate = self
        field.autocorrectionType = .no; field.autocapitalizationType = .none
        field.addTarget(self, action:#selector(textChanged), for:.editingChanged); view.addSubview(field)
        label.frame = CGRect(x:20,y:240,width:350,height:200); label.numberOfLines = 0; label.textColor = .black; view.addSubview(label)
        let pinch = UIPinchGestureRecognizer(target:self,action:#selector(pinched(_:))); view.addGestureRecognizer(pinch)
        let rotate = UIRotationGestureRecognizer(target:self,action:#selector(rotated(_:))); view.addGestureRecognizer(rotate)
        NotificationCenter.default.addObserver(forName:UIResponder.keyboardDidShowNotification,object:nil,queue:.main) { [weak self] _ in self?.record(["kind":"keyboard","visible":true]) }
        NotificationCenter.default.addObserver(forName:UIResponder.keyboardDidHideNotification,object:nil,queue:.main) { [weak self] _ in self?.record(["kind":"keyboard","visible":false]) }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(forName:UIDevice.orientationDidChangeNotification,object:nil,queue:.main) { [weak self] _ in self?.record(["kind":"orientation","value":UIDevice.current.orientation.rawValue]) }
        record(["kind":"ready","width":view.bounds.width,"height":view.bounds.height,"scale":UIScreen.main.scale])
    }
    @objc func textChanged() { record(["kind":"text","text":field.text ?? ""]) }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { record(["kind":"key","key":"return"]); return true }
    @objc func pinched(_ gesture:UIPinchGestureRecognizer) { record(["kind":"pinch","scale":gesture.scale,"state":gesture.state.rawValue]) }
    @objc func rotated(_ gesture:UIRotationGestureRecognizer) { record(["kind":"rotate","angle":gesture.rotation,"state":gesture.state.rawValue]) }
    func record(_ event: [String: Any]) {
        receipts.append(event.merging(["atSeconds": ProcessInfo.processInfo.systemUptime]) { first, _ in first })
        label.text = String(describing:event)
        if let data = try? JSONSerialization.data(withJSONObject:receipts,options:[.sortedKeys]), let dir = FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first { try? data.write(to:dir.appendingPathComponent("receipts.json"),options:.atomic) }
    }
}
final class App: UIResponder, UIApplicationDelegate {
    var window:UIWindow?
    func applicationWillResignActive(_ application:UIApplication) { (window?.rootViewController as? Controller)?.record(["kind":"lifecycle","state":"inactive"]) }
    func applicationDidEnterBackground(_ application:UIApplication) { (window?.rootViewController as? Controller)?.record(["kind":"lifecycle","state":"background"]) }
    func applicationDidBecomeActive(_ application:UIApplication) { (window?.rootViewController as? Controller)?.record(["kind":"lifecycle","state":"active"]) }
    func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]?) -> Bool {
        window = UIWindow(frame:UIScreen.main.bounds); window?.rootViewController = Controller(); window?.makeKeyAndVisible(); return true
    }
}
UIApplicationMain(CommandLine.argc,CommandLine.unsafeArgv,nil,NSStringFromClass(App.self))
