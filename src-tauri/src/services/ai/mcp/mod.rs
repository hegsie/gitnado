//! Model Context Protocol (MCP) server
//!
//! Allows external tools to query Gitnado's Git repository context
//! via the MCP protocol over HTTP/SSE.

pub mod server;
pub mod tools;

pub use server::{create_mcp_state, McpConfig, McpServer, McpState, McpStatus};
