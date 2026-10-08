import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    /// The app lock's cover while the app is in the background; nil otherwise.
    private var lockCover: UIView?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // The app-switcher snapshot is taken after the scene enters the
    // background, before the WebView can be trusted to have drawn the lock
    // screen (spec 2026-10-06-pairing-code-and-app-lock-design § 3). Not on
    // resign-active: the Face ID prompt resigns it too, over the lock screen.
    func sceneDidEnterBackground(_ scene: UIScene) {
        guard let window, lockCover == nil, AppLockCover.isOn else { return }
        let cover = AppLockCover.make(in: window)
        window.addSubview(cover)
        lockCover = cover
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        lockCover?.removeFromSuperview()
        lockCover = nil
    }
}

/// Canvas 9t drawn natively for the snapshot: the background and the lit
/// Orbital mark, nothing from the Mac.
private enum AppLockCover {
    /// Capacitor Preferences keeps the web app's settings in UserDefaults under this prefix.
    private static let prefix = "CapacitorStorage."

    /// `APP_LOCK_KEY` (on unless "false") and `PAIRING_KEY` in web/src/mobile/platform: the lock applies only while a Mac is paired.
    static var isOn: Bool {
        let defaults = UserDefaults.standard
        return defaults.string(forKey: prefix + "orbital.appLock") != "false"
            && defaults.string(forKey: prefix + "orbital.pairing") != nil
    }

    /// `--color-space` and `--color-accent` (oklch(85% .12 205)) of web/src/theme.css.
    private static let space = UIColor(red: 5 / 255, green: 7 / 255, blue: 13 / 255, alpha: 1)
    private static let accent = UIColor(red: 89 / 255, green: 228 / 255, blue: 243 / 255, alpha: 1)

    static func make(in window: UIWindow) -> UIView {
        let cover = UIView(frame: window.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = space

        // canvas 9t: a 72 pt ring with a 2 pt rim and a 14 pt moon inset 2 pt
        // from its top right, centred over Unlock's footer as the web screen has it.
        let insets = window.safeAreaInsets
        let footer: CGFloat = 68 + 40
        let centreY = insets.top + (window.bounds.height - insets.top - insets.bottom - footer) / 2
        let ring = UIView(frame: CGRect(x: 0, y: 0, width: 72, height: 72))
        ring.center = CGPoint(x: window.bounds.midX, y: centreY)
        ring.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
        ring.layer.cornerRadius = 36
        ring.layer.borderWidth = 2
        ring.layer.borderColor = accent.cgColor
        glow(ring.layer, radius: 15, opacity: 0.35)

        let moon = UIView(frame: CGRect(x: 72 - 2 - 14, y: 2, width: 14, height: 14))
        moon.backgroundColor = accent
        moon.layer.cornerRadius = 7
        glow(moon.layer, radius: 6, opacity: 1)
        ring.addSubview(moon)

        cover.addSubview(ring)
        return cover
    }

    /// A CSS `box-shadow: 0 0 <2 × radius>px` in the accent.
    private static func glow(_ layer: CALayer, radius: CGFloat, opacity: Float) {
        layer.shadowColor = accent.cgColor
        layer.shadowOffset = .zero
        layer.shadowRadius = radius
        layer.shadowOpacity = opacity
    }
}
