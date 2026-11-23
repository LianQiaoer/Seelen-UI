use seelen_core::{Rect, system_state::AppBarEdge};
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{
        RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW, RedrawWindow,
    },
    UI::WindowsAndMessaging::SWP_ASYNCWINDOWPOS,
};

use crate::{
    error::{Result, ResultLogExt},
    platform::window::Window,
    windows_api::{AppBarData, WindowsApi},
};

pub fn native_window(webview: &tauri::WebviewWindow) -> Result<Window> {
    Ok(Window::from(hwnd(webview)?))
}

pub fn set_owner<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    owner: &Window,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    // SAFETY: HWND in windows 0.61 (tauri) and 0.62 (ours) share the same memory layout
    #[allow(clippy::missing_transmute_annotations)]
    builder.owner_raw(unsafe { std::mem::transmute(owner.address()) })
}

pub fn disable_system_transitions(webview: &tauri::WebviewWindow) -> Result<()> {
    WindowsApi::set_system_transitions_disabled(hwnd(webview)?, true)
}

pub fn set_position(webview: &tauri::WebviewWindow, rect: &Rect) -> Result<()> {
    let hwnd = hwnd(webview)?;
    let rect = to_win32_rect(rect);

    // pre set position for resize in case of multiples dpi
    WindowsApi::move_window(hwnd, &rect)?;
    WindowsApi::set_position(hwnd, None, &rect, SWP_ASYNCWINDOWPOS)?;
    // ensure child windows are redrawn
    unsafe {
        let _ = RedrawWindow(
            Some(hwnd),
            None,
            None,
            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN | RDW_FRAME | RDW_ERASE,
        );
    }
    Ok(())
}

pub fn register_app_bar(
    webview: &tauri::WebviewWindow,
    rect: &Rect,
    edge: AppBarEdge,
) -> Result<()> {
    let mut app_bar = AppBarData::from_handle(hwnd(webview)?);
    app_bar.set_rect(to_win32_rect(rect));
    app_bar.set_edge(edge);
    app_bar.register_as_new_bar()
}

pub fn unregister_app_bar(webview: &tauri::WebviewWindow) -> Result<()> {
    let mut app_bar = AppBarData::from_handle(hwnd(webview)?);
    app_bar.unregister_bar()
}

/// Makes the webview render 1 CSS px = 1 physical px (`devicePixelRatio` = 1) on every monitor.
///
/// By default WebView2 tracks the monitor DPI itself (`ShouldDetectMonitorScaleChanges`) and
/// updates its `RasterizationScale` asynchronously after the window crosses monitors, so any
/// zoom-based compensation done from the webview races against it (and against `WM_DPICHANGED`
/// not being delivered to hidden windows). Taking ownership of the scale and pinning it to 1.0
/// removes the race entirely: the scale never changes again, whatever monitor the window is on.
pub fn lock_rasterization_scale_to_one(webview: &tauri::WebviewWindow) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows_core::Interface;

    webview.with_webview(|platform_webview| {
        let controller = platform_webview.controller();
        let result = (|| unsafe {
            // reset any zoom compensation applied before (zoom persists across reloads)
            controller.SetZoomFactor(1.0)?;
            let controller = controller.cast::<ICoreWebView2Controller3>()?;
            controller.SetShouldDetectMonitorScaleChanges(false)?;
            controller.SetRasterizationScale(1.0)
        })();

        if let Err(err) = result {
            log::error!("Failed to lock webview rasterization scale: {err:?}");
        }
    })?;
    Ok(())
}

/// Forces the WebView2 renderer to react as if the OS was under memory pressure,
/// via the same CDP call DevTools issues internally. Unlike `window.gc()`, this
/// actually makes V8/Blink release freed pages back to the OS, because real pressure
/// almost never reaches an individual background widget when the system overall has
/// plenty of RAM free.
pub fn simulate_memory_pressure(webview: &tauri::WebviewWindow) {
    if webview.is_focused().unwrap_or(false) {
        return;
    }

    webview
        .with_webview(|platform_webview| {
            let controller = platform_webview.controller();
            let core_webview = match unsafe { controller.CoreWebView2() } {
                Ok(core_webview) => core_webview,
                Err(err) => {
                    log::warn!("Failed to get ICoreWebView2 for memory pressure simulation: {err}");
                    return;
                }
            };

            // Can't use our own `WindowsString` here: webview2-com pins its own `windows`
            // crate version (0.61) which is semver-incompatible with the one this project
            // depends on directly (0.62.2), so their `PCWSTR` types don't unify. Must go
            // through webview2-com's own string helper, built against its own `windows`.
            let result =
                webview2_com::CallDevToolsProtocolMethodCompletedHandler::wait_for_async_operation(
                    Box::new(move |handler| unsafe {
                        let method = webview2_com::CoTaskMemPWSTR::from(
                            "Memory.simulatePressureNotification",
                        );
                        let params = webview2_com::CoTaskMemPWSTR::from(r#"{"level":"critical"}"#);
                        core_webview
                            .CallDevToolsProtocolMethod(
                                *method.as_ref().as_pcwstr(),
                                *params.as_ref().as_pcwstr(),
                                &handler,
                            )
                            .map_err(webview2_com::Error::WindowsError)
                    }),
                    Box::new(|error_code, _result| error_code),
                );

            if let Err(err) = result {
                log::warn!("Memory.simulatePressureNotification failed: {err:?}");
            }
        })
        .log_error();
}

// SAFETY: HWND in windows 0.61 (tauri) and 0.62 (ours) share the same memory layout
fn hwnd(webview: &tauri::WebviewWindow) -> Result<HWND> {
    Ok(HWND(webview.hwnd()?.0))
}

fn to_win32_rect(rect: &Rect) -> RECT {
    RECT {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

// =============================================================================
// Native file drop target (fork addition for the built-in launchpad widget)
//
// The webview drag-drop channel refuses file drops on some machines at the OS
// hover stage, before any event reaches the page. To make dropping files into
// the launchpad reliable, the backend registers its own OLE IDropTarget on
// the launchpad window, replacing the webview's built-in handler for that
// window only, and forwards the dropped paths to the webview as tauri events
// (`slu-launchpad-drop` / `slu-launchpad-hover`). Other widget windows keep
// the default webview handler untouched.
// =============================================================================

use std::{collections::HashMap, sync::LazyLock};

use tauri::Emitter;
use windows::Win32::{
    Foundation::POINTL,
    System::{
        Com::{DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL},
        Ole::{
            DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget, IDropTarget_Impl,
            RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
        },
        SystemServices::MODIFIERKEYS_FLAGS,
    },
    UI::Shell::{DragQueryFileW, HDROP},
};

use crate::utils::lock_free::TracedMutex;

/// CF_HDROP clipboard format id (shell file drop).
const CF_HDROP_ID: u16 = 15;

fn file_drop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP_ID,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn data_has_files(data: &IDataObject) -> bool {
    unsafe { data.QueryGetData(&file_drop_format()) }.is_ok()
}

fn extract_dropped_paths(data: &IDataObject) -> Vec<String> {
    let mut paths = Vec::new();
    let Ok(mut medium) = (unsafe { data.GetData(&file_drop_format()) }) else {
        return paths;
    };
    let hdrop = HDROP(unsafe { medium.u.hGlobal.0 });
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    for i in 0..count {
        let len = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
        if len == 0 {
            continue;
        }
        let mut buf = vec![0u16; len + 1];
        let written = unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) } as usize;
        if written > 0 {
            buf.truncate(written);
            paths.push(String::from_utf16_lossy(&buf));
        }
    }
    unsafe { ReleaseStgMedium(&mut medium) };
    paths
}

#[windows_core::implement(IDropTarget)]
struct LaunchpadDropTarget {
    window: tauri::WebviewWindow,
}

impl IDropTarget_Impl for LaunchpadDropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        let allowed = pdataobj.as_ref().is_some_and(data_has_files);
        unsafe {
            *pdweffect = if allowed { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
        if allowed {
            let _ = self.window.emit("slu-launchpad-hover", true);
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        unsafe {
            *pdweffect = DROPEFFECT_COPY;
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows_core::Result<()> {
        let _ = self.window.emit("slu-launchpad-hover", false);
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: windows_core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows_core::Result<()> {
        let _ = self.window.emit("slu-launchpad-hover", false);
        if let Some(data) = pdataobj.as_ref() {
            let paths = extract_dropped_paths(data);
            unsafe {
                *pdweffect = if paths.is_empty() { DROPEFFECT_NONE } else { DROPEFFECT_COPY };
            }
            if !paths.is_empty() {
                let _ = self.window.emit("slu-launchpad-drop", paths);
            }
        }
        Ok(())
    }
}

/// Keeps every registered drop target alive for the lifetime of its window.
/// The COM interface pointer is only ever used on the window's own thread
/// (registration) and by the COM runtime calling back into it; the wrapper
/// exists because the raw interface type is not Send/Sync.
struct StoredDropTarget(IDropTarget);

// SAFETY: the target is registered on, and called back on, the main UI
// thread; the static only keeps its reference count alive.
unsafe impl Send for StoredDropTarget {}
unsafe impl Sync for StoredDropTarget {}

static FILE_DROP_TARGETS: LazyLock<TracedMutex<HashMap<isize, StoredDropTarget>>> =
    LazyLock::new(|| TracedMutex::new(HashMap::new()));

/// Replaces the webview's built-in drag-drop handler on this window with the
/// native file drop target above.
pub fn register_native_file_drop(webview: &tauri::WebviewWindow) -> Result<()> {
    let target_hwnd = hwnd(webview)?;
    let target: IDropTarget = LaunchpadDropTarget {
        window: webview.clone(),
    }
    .into();
    unsafe {
        // Drop any target registered before (the webview's built-in handler,
        // or an earlier registration of ours if the window was recreated).
        let _ = RevokeDragDrop(target_hwnd);
        RegisterDragDrop(target_hwnd, &target)?;
    }
    FILE_DROP_TARGETS
        .lock()
        .insert(target_hwnd.0 as isize, StoredDropTarget(target));
    Ok(())
}
