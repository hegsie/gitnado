//! System hardware detection for local AI model recommendations
//!
//! Detects available RAM, GPU, NPU, and compute backend capabilities to
//! recommend appropriate model tiers and configure hardware acceleration.

use serde::{Deserialize, Serialize};

use super::model_registry::ModelTier;

/// GPU vendor classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendor {
    Apple,
    Nvidia,
    Amd,
    Intel,
    Unknown,
}

/// Active or supported compute backend for local inference
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeBackend {
    Metal,
    Cuda,
    Rocm,
    Vulkan,
    Cpu,
}

/// Neural Processing Unit (NPU) vendor classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NpuVendor {
    AppleNeuralEngine,
    AmdXdna,
    IntelNpu,
    QualcommHexagon,
    Unknown,
}

/// Information about the system's Neural Processing Unit (NPU)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpuInfo {
    pub name: String,
    pub vendor: NpuVendor,
    pub available: bool,
}

/// Information about the system's GPU
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: GpuVendor,
    pub vram_bytes: Option<u64>,
    pub metal_supported: bool,
    pub cuda_supported: bool,
    pub rocm_supported: bool,
    pub vulkan_supported: bool,
    pub unified_memory: bool,
}

/// Detected system capabilities for local AI inference
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapabilities {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub gpu_info: Option<GpuInfo>,
    pub recommended_tier: ModelTier,
    /// Whether GPU acceleration (Metal/CUDA/ROCm/Vulkan) is available at inference time.
    /// If false, only small models should be recommended since CPU inference is slow.
    pub gpu_acceleration_available: bool,
    pub active_backend: ComputeBackend,
    pub supported_backends: Vec<ComputeBackend>,
    pub npu_info: Option<NpuInfo>,
    pub unified_memory: bool,
}

const GB: u64 = 1_073_741_824;

/// Resolve the active compute backend and all hardware-supported backends.
pub fn detect_active_backend(gpu_info: &Option<GpuInfo>) -> (ComputeBackend, Vec<ComputeBackend>) {
    let mut supported_backends = Vec::new();

    if cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || gpu_info.as_ref().is_some_and(|g| g.metal_supported)
    {
        supported_backends.push(ComputeBackend::Metal);
    }

    if cfg!(feature = "cuda") || gpu_info.as_ref().is_some_and(|g| g.cuda_supported) {
        supported_backends.push(ComputeBackend::Cuda);
    }

    if cfg!(feature = "rocm") || gpu_info.as_ref().is_some_and(|g| g.rocm_supported) {
        supported_backends.push(ComputeBackend::Rocm);
    }

    if cfg!(feature = "vulkan") || gpu_info.as_ref().is_some_and(|g| g.vulkan_supported) {
        supported_backends.push(ComputeBackend::Vulkan);
    }

    supported_backends.push(ComputeBackend::Cpu);

    let active_backend = if cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || (cfg!(target_os = "macos") && gpu_info.as_ref().is_some_and(|g| g.metal_supported))
    {
        ComputeBackend::Metal
    } else if cfg!(feature = "cuda") && gpu_info.as_ref().is_none_or(|g| g.cuda_supported) {
        ComputeBackend::Cuda
    } else if cfg!(feature = "rocm") && gpu_info.as_ref().is_none_or(|g| g.rocm_supported) {
        ComputeBackend::Rocm
    } else if cfg!(feature = "vulkan") && gpu_info.as_ref().is_none_or(|g| g.vulkan_supported) {
        ComputeBackend::Vulkan
    } else {
        ComputeBackend::Cpu
    };

    (active_backend, supported_backends)
}

/// Detect system capabilities for local AI inference.
pub fn detect() -> SystemCapabilities {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();

    let total_ram_bytes = sys.total_memory();
    let available_ram_bytes = sys.available_memory();

    let gpu_info = detect_gpu(total_ram_bytes);
    let npu_info = detect_npu();
    let (active_backend, supported_backends) = detect_active_backend(&gpu_info);
    let gpu_acceleration_available = active_backend != ComputeBackend::Cpu;
    let unified_memory = gpu_info.as_ref().is_some_and(|g| g.unified_memory)
        || cfg!(all(target_os = "macos", target_arch = "aarch64"));

    let recommended_tier = recommend_tier(total_ram_bytes, &gpu_info, gpu_acceleration_available);

    SystemCapabilities {
        total_ram_bytes,
        available_ram_bytes,
        gpu_info,
        recommended_tier,
        gpu_acceleration_available,
        active_backend,
        supported_backends,
        npu_info,
        unified_memory,
    }
}

/// Calculate the recommended model tier based on system capabilities.
///
/// `gpu_acceleration_available` indicates whether the binary has GPU acceleration
/// (Metal/CUDA/ROCm/Vulkan) enabled and working. Without it, we cap at UltraLight (1B models)
/// since larger models are too slow on CPU.
pub fn recommend_tier(
    total_ram_bytes: u64,
    gpu_info: &Option<GpuInfo>,
    gpu_acceleration_available: bool,
) -> ModelTier {
    let has_capable_gpu = gpu_acceleration_available
        && gpu_info
            .as_ref()
            .map(|gpu| {
                // Apple Silicon (Metal) is always capable
                if gpu.vendor == GpuVendor::Apple && gpu.metal_supported {
                    return true;
                }
                // NVIDIA with >= 4GB VRAM
                if gpu.vendor == GpuVendor::Nvidia {
                    if let Some(vram) = gpu.vram_bytes {
                        return vram >= 4 * GB;
                    }
                }
                // AMD with ROCm or Vulkan support and >= 4GB VRAM or unified memory
                if gpu.vendor == GpuVendor::Amd && (gpu.rocm_supported || gpu.vulkan_supported) {
                    if gpu.unified_memory {
                        return true;
                    }
                    if let Some(vram) = gpu.vram_bytes {
                        return vram >= 4 * GB;
                    }
                }
                false
            })
            .unwrap_or(false);

    let has_pro_gpu = has_capable_gpu
        && gpu_info.as_ref().is_some_and(|gpu| {
            (gpu.unified_memory && total_ram_bytes >= 32 * GB)
                || gpu.vram_bytes.is_some_and(|vram| vram >= 8 * GB)
        });

    if total_ram_bytes >= 32 * GB && has_pro_gpu {
        ModelTier::Pro
    } else if total_ram_bytes >= 16 * GB && has_capable_gpu {
        ModelTier::Standard
    } else if total_ram_bytes >= 8 * GB {
        ModelTier::UltraLight
    } else {
        ModelTier::None
    }
}

/// Detect GPU information. Platform-specific implementation.
fn detect_gpu(total_ram_bytes: u64) -> Option<GpuInfo> {
    #[cfg(target_os = "macos")]
    {
        detect_gpu_macos(total_ram_bytes)
    }

    #[cfg(target_os = "windows")]
    {
        detect_gpu_windows(total_ram_bytes)
    }

    #[cfg(target_os = "linux")]
    {
        detect_gpu_linux(total_ram_bytes)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = total_ram_bytes;
        None
    }
}

/// Detect Neural Processing Unit (NPU) information. Platform-specific implementation.
fn detect_npu() -> Option<NpuInfo> {
    #[cfg(target_os = "macos")]
    {
        detect_npu_macos()
    }

    #[cfg(target_os = "windows")]
    {
        detect_npu_windows()
    }

    #[cfg(target_os = "linux")]
    {
        detect_npu_linux()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn detect_npu_macos() -> Option<NpuInfo> {
    if cfg!(target_arch = "aarch64") {
        Some(NpuInfo {
            name: "Apple Neural Engine (ANE)".to_string(),
            vendor: NpuVendor::AppleNeuralEngine,
            available: true,
        })
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn detect_gpu_macos(total_ram_bytes: u64) -> Option<GpuInfo> {
    let output = std::process::Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&json_str).ok()?;

    let displays = parsed.get("SPDisplaysDataType")?.as_array()?;
    let first = displays.first()?;

    let name = first
        .get("sppci_model")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown GPU")
        .to_string();

    // Detect vendor from chipset or model name
    let vendor = if name.contains("Apple") || first.get("sppci_vendor").is_none() {
        // Apple Silicon GPUs don't have a separate vendor field typically
        GpuVendor::Apple
    } else {
        let vendor_str = first
            .get("sppci_vendor")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if vendor_str.contains("NVIDIA") || vendor_str.contains("nvidia") {
            GpuVendor::Nvidia
        } else if vendor_str.contains("AMD") || vendor_str.contains("amd") {
            GpuVendor::Amd
        } else if vendor_str.contains("Intel") || vendor_str.contains("intel") {
            GpuVendor::Intel
        } else {
            GpuVendor::Unknown
        }
    };

    let unified_memory = vendor == GpuVendor::Apple || cfg!(target_arch = "aarch64");

    // On Apple Silicon, VRAM is shared with system RAM
    let parsed_vram_bytes = first
        .get("sppci_vram_shared")
        .or_else(|| first.get("sppci_vram"))
        .and_then(|v| v.as_str())
        .and_then(|s| {
            // Format is typically "X GB" or "X MB"
            let s = s.trim();
            if let Some(gb_str) = s.strip_suffix(" GB") {
                gb_str.trim().parse::<u64>().ok().map(|n| n * GB)
            } else if let Some(mb_str) = s.strip_suffix(" MB") {
                mb_str.trim().parse::<u64>().ok().map(|n| n * 1_048_576)
            } else {
                None
            }
        });

    let vram_bytes = parsed_vram_bytes.or_else(|| {
        if unified_memory && total_ram_bytes > 0 {
            // Apple Silicon Metal working set defaults to ~75% of unified memory
            Some((total_ram_bytes * 3) / 4)
        } else {
            None
        }
    });

    let metal_supported = vendor == GpuVendor::Apple
        || first
            .get("sppci_metal_supported")
            .and_then(|v| v.as_str())
            .map(|s| s.contains("supported") || s.contains("spdisplays_supported"))
            .unwrap_or(false);

    Some(GpuInfo {
        name,
        vendor,
        vram_bytes,
        metal_supported,
        cuda_supported: false,
        rocm_supported: false,
        vulkan_supported: false,
        unified_memory,
    })
}

/// Check if an AMD GPU/APU name indicates a unified-memory Ryzen AI / Radeon iGPU.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn is_amd_unified_memory_apu(name_lower: &str) -> bool {
    name_lower.contains("ryzen ai")
        || name_lower.contains("radeon 780m")
        || name_lower.contains("radeon 760m")
        || name_lower.contains("radeon 740m")
        || name_lower.contains("radeon 880m")
        || name_lower.contains("radeon 890m")
        || name_lower.contains("radeon 8060s")
        || name_lower.contains("radeon 8050s")
        || name_lower.contains("strix")
}

/// Parse Windows `Win32_VideoController` JSON output (single object or array of objects)
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn parse_windows_gpu_json(json_str: &str, total_ram_bytes: u64) -> Option<GpuInfo> {
    let parsed: serde_json::Value = serde_json::from_str(json_str.trim()).ok()?;
    let controllers: Vec<&serde_json::Value> = match &parsed {
        serde_json::Value::Array(arr) => arr.iter().collect(),
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => return None,
    };

    // Prefer discrete or capable GPUs (NVIDIA / AMD) over basic display adapters
    let chosen = controllers
        .iter()
        .copied()
        .find(|c| {
            let n = c
                .get("Name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            n.contains("nvidia")
                || n.contains("geforce")
                || n.contains("rtx")
                || n.contains("amd")
                || n.contains("radeon")
        })
        .or_else(|| controllers.first().copied())?;

    let name = chosen.get("Name")?.as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }

    let raw_vram = chosen.get("AdapterRAM").and_then(|v| v.as_u64());
    build_windows_gpu_info(name, raw_vram, total_ram_bytes)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn build_windows_gpu_info(
    name: String,
    raw_vram: Option<u64>,
    total_ram_bytes: u64,
) -> Option<GpuInfo> {
    if name.is_empty() {
        return None;
    }

    let name_lower = name.to_lowercase();
    let vendor = if name_lower.contains("nvidia")
        || name_lower.contains("geforce")
        || name_lower.contains("rtx")
        || name_lower.contains("quadro")
    {
        GpuVendor::Nvidia
    } else if name_lower.contains("amd") || name_lower.contains("radeon") {
        GpuVendor::Amd
    } else if name_lower.contains("intel") || name_lower.contains("arc") {
        GpuVendor::Intel
    } else {
        GpuVendor::Unknown
    };

    let unified_memory = vendor == GpuVendor::Amd && is_amd_unified_memory_apu(&name_lower);
    // Win32_VideoController AdapterRAM is a 32-bit uint in WMI and caps near 4GB (0xFFF00000).
    // Round capped values (>= 3.9GB) up to 4GB so 4GB+ GPUs aren't penalized by the WMI cap.
    let normalized_vram = raw_vram.map(|v| {
        if (4_187_593_113..4 * GB).contains(&v) {
            4 * GB
        } else {
            v
        }
    });

    let vram_bytes = if unified_memory && total_ram_bytes >= 16 * GB {
        match normalized_vram {
            Some(v) if v >= 4 * GB => Some(v),
            _ => Some((total_ram_bytes * 3) / 4),
        }
    } else {
        normalized_vram
    };

    let cuda_supported = vendor == GpuVendor::Nvidia;
    let rocm_supported = vendor == GpuVendor::Amd;
    let vulkan_supported = matches!(
        vendor,
        GpuVendor::Nvidia | GpuVendor::Amd | GpuVendor::Intel
    );

    Some(GpuInfo {
        name,
        vendor,
        vram_bytes,
        metal_supported: false,
        cuda_supported,
        rocm_supported,
        vulkan_supported,
        unified_memory,
    })
}

#[cfg(target_os = "windows")]
fn detect_gpu_windows(total_ram_bytes: u64) -> Option<GpuInfo> {
    // Primary: PowerShell Get-CimInstance (wmic is deprecated/removed in modern Windows 11)
    if let Ok(output) = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
        ])
        .output()
    {
        if output.status.success() {
            let json_str = String::from_utf8_lossy(&output.stdout);
            if let Some(info) = parse_windows_gpu_json(&json_str, total_ram_bytes) {
                return Some(info);
            }
        }
    }

    // Fallback: legacy wmic
    let output = std::process::Command::new("wmic")
        .args([
            "path",
            "win32_VideoController",
            "get",
            "Name,AdapterRAM",
            "/format:list",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut name = String::new();
    let mut vram_bytes: Option<u64> = None;

    for line in text.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("Name=") {
            name = val.to_string();
        } else if let Some(val) = line.strip_prefix("AdapterRAM=") {
            vram_bytes = val.parse::<u64>().ok();
        }
    }

    build_windows_gpu_info(name, vram_bytes, total_ram_bytes)
}

#[cfg(target_os = "windows")]
fn detect_npu_windows() -> Option<NpuInfo> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'NPU|IPU|Neural|Ryzen AI|AI Boost|Hexagon' } | Select-Object -First 1 -ExpandProperty Name",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        return None;
    }

    let name_lower = name.to_lowercase();
    let vendor = if name_lower.contains("amd")
        || name_lower.contains("ryzen ai")
        || name_lower.contains("ipu")
        || name_lower.contains("xdna")
    {
        NpuVendor::AmdXdna
    } else if name_lower.contains("intel") || name_lower.contains("ai boost") {
        NpuVendor::IntelNpu
    } else if name_lower.contains("qualcomm") || name_lower.contains("hexagon") {
        NpuVendor::QualcommHexagon
    } else {
        NpuVendor::Unknown
    };

    Some(NpuInfo {
        name,
        vendor,
        available: true,
    })
}

#[cfg(target_os = "linux")]
fn detect_gpu_linux(total_ram_bytes: u64) -> Option<GpuInfo> {
    // Try NVIDIA first via proc filesystem
    if let Some(info) = detect_nvidia_linux() {
        return Some(info);
    }

    // Try AMD via sysfs DRM / ROCm
    if let Some(info) = detect_amd_linux(total_ram_bytes) {
        return Some(info);
    }

    // Fall back to lspci
    detect_gpu_lspci(total_ram_bytes)
}

#[cfg(target_os = "linux")]
fn has_vulkan_linux() -> bool {
    std::path::Path::new("/usr/share/vulkan/icd.d").exists()
        || std::path::Path::new("/etc/vulkan/icd.d").exists()
}

#[cfg(target_os = "linux")]
fn has_rocm_linux() -> bool {
    std::path::Path::new("/dev/kfd").exists()
        || std::path::Path::new("/opt/rocm").exists()
        || std::process::Command::new("rocm-smi")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
}

#[cfg(target_os = "linux")]
fn detect_nvidia_linux() -> Option<GpuInfo> {
    use std::fs;

    let nvidia_dir = std::path::Path::new("/proc/driver/nvidia/gpus");
    if !nvidia_dir.exists() {
        return None;
    }

    let entry = fs::read_dir(nvidia_dir).ok()?.next()?.ok()?;
    let info_path = entry.path().join("information");
    let content = fs::read_to_string(info_path).ok()?;

    let mut name = String::new();
    for line in content.lines() {
        if let Some(val) = line.strip_prefix("Model:") {
            name = val.trim().to_string();
            break;
        }
    }

    if name.is_empty() {
        name = "NVIDIA GPU".to_string();
    }

    // Try to get VRAM from nvidia-smi
    let vram_bytes = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()
        .and_then(|out| {
            let s = String::from_utf8_lossy(&out.stdout);
            s.trim().parse::<u64>().ok().map(|mb| mb * 1_048_576)
        });

    Some(GpuInfo {
        name,
        vendor: GpuVendor::Nvidia,
        vram_bytes,
        metal_supported: false,
        cuda_supported: true,
        rocm_supported: false,
        vulkan_supported: true,
        unified_memory: false,
    })
}

#[cfg(target_os = "linux")]
fn detect_amd_linux(total_ram_bytes: u64) -> Option<GpuInfo> {
    use std::fs;

    let drm_dir = std::path::Path::new("/sys/class/drm");
    if !drm_dir.exists() {
        return None;
    }

    let entries = fs::read_dir(drm_dir).ok()?;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let card_name = file_name.to_string_lossy();
        if !card_name.starts_with("card") || card_name.contains('-') {
            continue;
        }

        let device_dir = entry.path().join("device");
        let vendor_str = fs::read_to_string(device_dir.join("vendor"))
            .unwrap_or_default()
            .trim()
            .to_lowercase();

        if vendor_str != "0x1002" {
            continue;
        }

        let dedicated_vram = fs::read_to_string(device_dir.join("mem_info_vram_total"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok());

        let gtt_total = fs::read_to_string(device_dir.join("mem_info_gtt_total"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok());

        let product_name = fs::read_to_string(device_dir.join("product_name"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let name = product_name
            .or_else(detect_amd_name_from_lspci)
            .unwrap_or_else(|| "AMD Radeon GPU".to_string());

        let name_lower = name.to_lowercase();
        // Unified memory APU if GTT >= 16GB and dedicated carveout is small (< 4GB),
        // or if known Ryzen AI / Radeon APU model
        let is_apu_gtt = gtt_total.is_some_and(|gtt| gtt >= 16 * GB)
            && dedicated_vram.is_none_or(|v| v < 4 * GB);
        let unified_memory = is_apu_gtt || is_amd_unified_memory_apu(&name_lower);

        let vram_bytes = if unified_memory {
            dedicated_vram
                .filter(|&v| v >= 4 * GB)
                .or(gtt_total)
                .or_else(|| {
                    if total_ram_bytes > 0 {
                        Some((total_ram_bytes * 3) / 4)
                    } else {
                        None
                    }
                })
        } else {
            dedicated_vram
        };

        let rocm_supported = has_rocm_linux();
        let vulkan_supported = has_vulkan_linux() || true;

        return Some(GpuInfo {
            name,
            vendor: GpuVendor::Amd,
            vram_bytes,
            metal_supported: false,
            cuda_supported: false,
            rocm_supported,
            vulkan_supported,
            unified_memory,
        });
    }

    None
}

#[cfg(target_os = "linux")]
fn detect_amd_name_from_lspci() -> Option<String> {
    let output = std::process::Command::new("lspci").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if (line.contains("VGA")
            || line.contains("3D controller")
            || line.contains("Display controller"))
            && (line.to_lowercase().contains("amd") || line.to_lowercase().contains("radeon"))
        {
            if let Some(name) = line.split(':').nth(2) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_gpu_lspci(total_ram_bytes: u64) -> Option<GpuInfo> {
    let output = std::process::Command::new("lspci").output().ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);

    // Look for VGA or 3D controller lines
    for line in text.lines() {
        if line.contains("VGA")
            || line.contains("3D controller")
            || line.contains("Display controller")
        {
            let name_lower = line.to_lowercase();
            let vendor = if name_lower.contains("nvidia") {
                GpuVendor::Nvidia
            } else if name_lower.contains("amd") || name_lower.contains("radeon") {
                GpuVendor::Amd
            } else if name_lower.contains("intel") {
                GpuVendor::Intel
            } else {
                GpuVendor::Unknown
            };

            // Extract name from after the colon
            let name = line
                .split(':')
                .nth(2)
                .unwrap_or("Unknown GPU")
                .trim()
                .to_string();

            let unified_memory = vendor == GpuVendor::Amd && is_amd_unified_memory_apu(&name_lower);
            let vram_bytes = if unified_memory && total_ram_bytes >= 16 * GB {
                Some((total_ram_bytes * 3) / 4)
            } else {
                None
            };

            return Some(GpuInfo {
                name,
                vendor,
                vram_bytes,
                metal_supported: false,
                cuda_supported: vendor == GpuVendor::Nvidia,
                rocm_supported: vendor == GpuVendor::Amd && has_rocm_linux(),
                vulkan_supported: matches!(
                    vendor,
                    GpuVendor::Nvidia | GpuVendor::Amd | GpuVendor::Intel
                ) && has_vulkan_linux(),
                unified_memory,
            });
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn detect_npu_linux() -> Option<NpuInfo> {
    use std::fs;

    let accel_dev = std::path::Path::new("/dev/accel/accel0");
    let accel_sys = std::path::Path::new("/sys/class/accel/accel0");

    if accel_dev.exists() || accel_sys.exists() {
        let vendor_str = fs::read_to_string(accel_sys.join("device/vendor"))
            .unwrap_or_default()
            .trim()
            .to_lowercase();

        let (name, vendor) = if vendor_str == "0x8086" {
            ("Intel NPU".to_string(), NpuVendor::IntelNpu)
        } else {
            ("AMD Ryzen AI NPU (XDNA)".to_string(), NpuVendor::AmdXdna)
        };

        return Some(NpuInfo {
            name,
            vendor,
            available: true,
        });
    }

    if let Ok(output) = std::process::Command::new("xrt-smi")
        .arg("examine")
        .output()
    {
        if output.status.success() {
            return Some(NpuInfo {
                name: "AMD Ryzen AI NPU (XDNA)".to_string(),
                vendor: NpuVendor::AmdXdna,
                available: true,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recommend_tier_standard_apple_silicon() {
        let gpu = Some(GpuInfo {
            name: "Apple M1".to_string(),
            vendor: GpuVendor::Apple,
            vram_bytes: None,
            metal_supported: true,
            cuda_supported: false,
            rocm_supported: false,
            vulkan_supported: false,
            unified_memory: true,
        });
        assert_eq!(recommend_tier(16 * GB, &gpu, true), ModelTier::Standard);
    }

    #[test]
    fn test_recommend_tier_standard_nvidia() {
        let gpu = Some(GpuInfo {
            name: "NVIDIA RTX 3060".to_string(),
            vendor: GpuVendor::Nvidia,
            vram_bytes: Some(6 * GB),
            metal_supported: false,
            cuda_supported: true,
            rocm_supported: false,
            vulkan_supported: true,
            unified_memory: false,
        });
        assert_eq!(recommend_tier(16 * GB, &gpu, true), ModelTier::Standard);
    }

    #[test]
    fn test_recommend_tier_ultralight_low_vram() {
        let gpu = Some(GpuInfo {
            name: "NVIDIA GTX 1050".to_string(),
            vendor: GpuVendor::Nvidia,
            vram_bytes: Some(2 * GB),
            metal_supported: false,
            cuda_supported: true,
            rocm_supported: false,
            vulkan_supported: true,
            unified_memory: false,
        });
        // 16GB RAM but GPU only has 2GB VRAM — falls to UltraLight
        assert_eq!(recommend_tier(16 * GB, &gpu, true), ModelTier::UltraLight);
    }

    #[test]
    fn test_recommend_tier_ultralight_enough_ram() {
        assert_eq!(recommend_tier(8 * GB, &None, false), ModelTier::UltraLight);
    }

    #[test]
    fn test_recommend_tier_none_low_ram() {
        assert_eq!(recommend_tier(4 * GB, &None, false), ModelTier::None);
    }

    #[test]
    fn test_recommend_tier_ultralight_no_gpu() {
        // 16GB RAM but no GPU at all — UltraLight (not Standard)
        assert_eq!(recommend_tier(16 * GB, &None, false), ModelTier::UltraLight);
    }

    #[test]
    fn test_recommend_tier_amd_gpu_not_standard() {
        let gpu = Some(GpuInfo {
            name: "AMD Radeon RX 6800".to_string(),
            vendor: GpuVendor::Amd,
            vram_bytes: Some(16 * GB),
            metal_supported: false,
            cuda_supported: false,
            rocm_supported: false,
            vulkan_supported: false,
            unified_memory: false,
        });
        // AMD GPUs without ROCm or Vulkan support don't qualify for Standard tier
        assert_eq!(recommend_tier(16 * GB, &gpu, true), ModelTier::UltraLight);
    }

    #[test]
    fn test_recommend_tier_standard_amd_rocm_or_vulkan() {
        let rocm_gpu = Some(GpuInfo {
            name: "AMD Radeon RX 7900 XTX".to_string(),
            vendor: GpuVendor::Amd,
            vram_bytes: Some(24 * GB),
            metal_supported: false,
            cuda_supported: false,
            rocm_supported: true,
            vulkan_supported: true,
            unified_memory: false,
        });
        assert_eq!(
            recommend_tier(16 * GB, &rocm_gpu, true),
            ModelTier::Standard
        );

        let apu_gpu = Some(GpuInfo {
            name: "AMD Radeon 890M (Ryzen AI 9 HX 370)".to_string(),
            vendor: GpuVendor::Amd,
            vram_bytes: None,
            metal_supported: false,
            cuda_supported: false,
            rocm_supported: false,
            vulkan_supported: true,
            unified_memory: true,
        });
        assert_eq!(recommend_tier(16 * GB, &apu_gpu, true), ModelTier::Standard);
        assert_eq!(recommend_tier(32 * GB, &apu_gpu, true), ModelTier::Pro);
    }

    #[test]
    fn test_recommend_tier_pro_32gb_unified_or_high_vram() {
        let apple_max_gpu = Some(GpuInfo {
            name: "Apple M3 Max".to_string(),
            vendor: GpuVendor::Apple,
            vram_bytes: Some(24 * GB),
            metal_supported: true,
            cuda_supported: false,
            rocm_supported: false,
            vulkan_supported: false,
            unified_memory: true,
        });
        assert_eq!(
            recommend_tier(32 * GB, &apple_max_gpu, true),
            ModelTier::Pro
        );

        let rtx_4070_gpu = Some(GpuInfo {
            name: "NVIDIA RTX 4070".to_string(),
            vendor: GpuVendor::Nvidia,
            vram_bytes: Some(12 * GB),
            metal_supported: false,
            cuda_supported: true,
            rocm_supported: false,
            vulkan_supported: true,
            unified_memory: false,
        });
        assert_eq!(recommend_tier(32 * GB, &rtx_4070_gpu, true), ModelTier::Pro);

        // 32GB system RAM but only 6GB dedicated VRAM stays Standard
        let rtx_3060_gpu = Some(GpuInfo {
            name: "NVIDIA RTX 3060".to_string(),
            vendor: GpuVendor::Nvidia,
            vram_bytes: Some(6 * GB),
            metal_supported: false,
            cuda_supported: true,
            rocm_supported: false,
            vulkan_supported: true,
            unified_memory: false,
        });
        assert_eq!(
            recommend_tier(32 * GB, &rtx_3060_gpu, true),
            ModelTier::Standard
        );
    }

    #[test]
    fn test_recommend_tier_cpu_only_caps_at_ultralight() {
        let gpu = Some(GpuInfo {
            name: "Apple M3 Max".to_string(),
            vendor: GpuVendor::Apple,
            vram_bytes: None,
            metal_supported: true,
            cuda_supported: false,
            rocm_supported: false,
            vulkan_supported: false,
            unified_memory: true,
        });
        // GPU hardware present but acceleration not available (CPU-only build)
        assert_eq!(recommend_tier(48 * GB, &gpu, false), ModelTier::UltraLight);
    }

    #[test]
    fn test_detect_runs_without_panic() {
        // Smoke test: detect() should not panic regardless of platform
        let caps = detect();
        assert!(caps.total_ram_bytes > 0);
        assert!(caps.supported_backends.contains(&ComputeBackend::Cpu));
    }

    #[test]
    fn test_detect_active_backend_includes_cpu() {
        let (active, supported) = detect_active_backend(&None);
        assert!(supported.contains(&ComputeBackend::Cpu));
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(active, ComputeBackend::Metal);
            assert!(supported.contains(&ComputeBackend::Metal));
        }
    }

    #[test]
    fn test_parse_windows_gpu_json_amd_apu_and_nvidia() {
        let apu_json =
            r#"{"Name":"AMD Radeon 890M","AdapterRAM":536870912,"DriverVersion":"32.0.1"}"#;
        let apu = parse_windows_gpu_json(apu_json, 32 * GB).unwrap();
        assert_eq!(apu.vendor, GpuVendor::Amd);
        assert!(apu.unified_memory);
        assert!(apu.rocm_supported);
        assert!(apu.vulkan_supported);
        assert_eq!(apu.vram_bytes, Some(24 * GB));

        let multi_json = r#"[{"Name":"Microsoft Basic Display Adapter","AdapterRAM":0},{"Name":"NVIDIA GeForce RTX 4070","AdapterRAM":4293918720}]"#;
        let nv = parse_windows_gpu_json(multi_json, 32 * GB).unwrap();
        assert_eq!(nv.vendor, GpuVendor::Nvidia);
        assert!(nv.cuda_supported);
        assert!(nv.vulkan_supported);
        assert!(!nv.unified_memory);
        assert_eq!(nv.vram_bytes, Some(4 * GB));
    }

    #[test]
    fn test_gpu_vendor_serialization() {
        let vendor = GpuVendor::Apple;
        let json = serde_json::to_string(&vendor).unwrap();
        assert_eq!(json, "\"apple\"");

        let deserialized: GpuVendor = serde_json::from_str("\"nvidia\"").unwrap();
        assert_eq!(deserialized, GpuVendor::Nvidia);
    }

    #[test]
    fn test_compute_backend_and_npu_serialization() {
        let backend = ComputeBackend::Metal;
        assert_eq!(serde_json::to_string(&backend).unwrap(), "\"metal\"");
        assert_eq!(
            serde_json::to_string(&ComputeBackend::Rocm).unwrap(),
            "\"rocm\""
        );

        let npu = NpuInfo {
            name: "Apple Neural Engine (ANE)".to_string(),
            vendor: NpuVendor::AppleNeuralEngine,
            available: true,
        };
        let npu_json = serde_json::to_string(&npu).unwrap();
        assert!(npu_json.contains("\"apple_neural_engine\""));
    }

    #[test]
    fn test_system_capabilities_serialization() {
        let caps = SystemCapabilities {
            total_ram_bytes: 16 * GB,
            available_ram_bytes: 8 * GB,
            gpu_info: None,
            recommended_tier: ModelTier::UltraLight,
            gpu_acceleration_available: false,
            active_backend: ComputeBackend::Cpu,
            supported_backends: vec![ComputeBackend::Cpu],
            npu_info: None,
            unified_memory: false,
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"totalRamBytes\""));
        assert!(json.contains("\"recommendedTier\""));
        assert!(json.contains("\"gpuAccelerationAvailable\""));
        assert!(json.contains("\"activeBackend\""));
        assert!(json.contains("\"supportedBackends\""));
        assert!(json.contains("\"unifiedMemory\""));
    }
}
