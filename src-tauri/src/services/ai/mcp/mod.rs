//! Model Context Protocol (MCP) server
//!
//! Allows external tools to query Gitnado's Git repository context
//! via the MCP protocol over HTTP/SSE.

pub mod insight;
pub mod server;
pub mod tools;
pub mod write;

pub use server::{create_mcp_state, McpConfig, McpServer, McpState, McpStatus};
