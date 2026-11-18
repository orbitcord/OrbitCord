//! Background priority for OrbitCord's own page process while its window is
//! hidden. macOS moves it to background QoS (efficiency cores, throttled disk
//! I/O); Windows lowers its priority class and turns on EcoQoS. Both are
//! undone when the window comes back. Linux can't raise priority again
//! without privileges, so it is left alone there.

/// Returns whether the change was applied on this platform.
pub fn set_background(pid: u32, background: bool) -> Result<bool, String> {
    imp::set_background(pid, background)
}

#[cfg(target_os = "macos")]
mod imp {
    const PRIO_DARWIN_PROCESS: i32 = 4;
    const PRIO_DARWIN_BG: i32 = 0x1000;
    extern "C" {
        fn setpriority(which: i32, who: u32, prio: i32) -> i32;
    }
    pub fn set_background(pid: u32, background: bool) -> Result<bool, String> {
        let prio = if background { PRIO_DARWIN_BG } else { 0 };
        // SAFETY: plain syscall on a pid; it fails cleanly for other users' processes.
        if unsafe { setpriority(PRIO_DARWIN_PROCESS, pid, prio) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(true)
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    const PROCESS_SET_INFORMATION: u32 = 0x0200;
    const NORMAL_PRIORITY_CLASS: u32 = 0x20;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
    const PROCESS_POWER_THROTTLING: i32 = 4;
    const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 1;
    #[repr(C)]
    struct PowerThrottling {
        version: u32,
        control_mask: u32,
        state_mask: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn SetPriorityClass(process: *mut c_void, class: u32) -> i32;
        fn SetProcessInformation(process: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub fn set_background(pid: u32, background: bool) -> Result<bool, String> {
        // SAFETY: the handle is checked and always closed; the struct matches
        // PROCESS_POWER_THROTTLING_STATE.
        unsafe {
            let process = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if process.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let class = if background { BELOW_NORMAL_PRIORITY_CLASS } else { NORMAL_PRIORITY_CLASS };
            let ok = SetPriorityClass(process, class) != 0;
            let state = PowerThrottling {
                version: 1,
                control_mask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                state_mask: if background { PROCESS_POWER_THROTTLING_EXECUTION_SPEED } else { 0 },
            };
            // EcoQoS needs Windows 10 1709+; older systems keep the class change.
            SetProcessInformation(process, PROCESS_POWER_THROTTLING,
                &state as *const PowerThrottling as *const c_void, std::mem::size_of::<PowerThrottling>() as u32);
            CloseHandle(process);
            if !ok {
                return Err("couldn't change process priority".into());
            }
        }
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn set_background(_pid: u32, _background: bool) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn backgrounds_and_restores_a_child_process() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        assert_eq!(super::set_background(child.id(), true), Ok(true));
        assert_eq!(super::set_background(child.id(), false), Ok(true));
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
