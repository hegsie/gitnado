#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `gitnado --mcp-stdio`: run as an MCP stdio bridge to the running app's
    // MCP server instead of opening a window (for MCP clients that only
    // speak stdio).
    if std::env::args().skip(1).any(|a| a == "--mcp-stdio") {
        std::process::exit(gitnado_lib::run_mcp_stdio_bridge());
    }
    gitnado_lib::run()
}
