//! AI assistant: one chat turn against a model provider, streamed.
//!
//! Two wire formats cover every supported provider: Anthropic's Messages API and the OpenAI Chat
//! Completions API (OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama, LM Studio and
//! any other OpenAI-compatible server). The agent loop and the tools live in the app; this module
//! only turns a provider-neutral conversation into a request and the streamed answer back into
//! provider-neutral parts.

use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;
pub use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Part {
    Text { text: String },
    ToolUse { id: String, name: String, input: Value },
    #[serde(rename_all = "camelCase")]
    ToolResult { tool_use_id: String, content: String, #[serde(default)] is_error: bool },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Msg {
    /// "user" | "assistant"
    pub role: String,
    pub content: Vec<Part>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON schema of the input object
    pub parameters: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatReq {
    /// "anthropic" | "openai"
    pub api: String,
    pub base_url: String,
    pub model: String,
    pub system: String,
    pub messages: Vec<Msg>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatResp {
    pub content: Vec<Part>,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(180))
        .user_agent(concat!("TermX/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Anthropic's base URL is the host; `/v1` is part of the path.
fn anthropic_url(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b.strip_suffix("/v1").unwrap_or(b);
    join(b, &format!("v1/{path}"))
}

/// Run one model turn. `on_text` receives streamed text as it arrives.
pub async fn chat(req: &ChatReq, key: Option<&str>, on_text: &(dyn Fn(&str) + Send + Sync), cancel: &CancellationToken) -> Result<ChatResp> {
    let http = client()?;
    let (url, body, headers) = match req.api.as_str() {
        "anthropic" => anthropic_request(req, key)?,
        "openai" => openai_request(req, key),
        other => bail!("unknown API format: {other}"),
    };
    let mut rb = http.post(&url).json(&body);
    for (k, v) in headers {
        rb = rb.header(k, v);
    }
    let resp = tokio::select! {
        r = rb.send() => r.map_err(|e| anyhow!("could not reach {}: {}", host_of(&url), root_cause(&e)))?,
        _ = cancel.cancelled() => bail!("cancelled"),
    };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        bail!("{} ({}): {}", host_of(&url), status.as_u16(), api_error(&text));
    }
    let mut sse = Sse::default();
    let mut stream = resp.bytes_stream();
    let mut acc = Acc::default();
    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.cancelled() => bail!("cancelled"),
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| anyhow!("stream interrupted: {}", root_cause(&e)))?;
        for data in sse.push(&chunk) {
            if data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            if req.api == "anthropic" {
                acc.anthropic_event(&v, on_text)?;
            } else {
                acc.openai_event(&v, on_text)?;
            }
        }
    }
    Ok(acc.finish())
}

/// Model ids offered by the provider (for the model picker).
pub async fn list_models(api: &str, base_url: &str, key: Option<&str>) -> Result<Vec<String>> {
    let http = client()?;
    let rb = if api == "anthropic" {
        let mut rb = http.get(anthropic_url(base_url, "models?limit=100")).header("anthropic-version", "2023-06-01");
        if let Some(k) = key {
            rb = rb.header("x-api-key", k);
        }
        rb
    } else {
        let mut rb = http.get(join(base_url, "models"));
        if let Some(k) = key {
            rb = rb.bearer_auth(k);
        }
        rb
    };
    let resp = rb.send().await.map_err(|e| anyhow!("could not reach {}: {}", host_of(base_url), root_cause(&e)))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("{} ({}): {}", host_of(base_url), status.as_u16(), api_error(&text));
    }
    let v: Value = serde_json::from_str(&text)?;
    let list = v.get("data").or_else(|| v.get("models")).and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let mut ids: Vec<String> = list
        .iter()
        .filter_map(|m| m.get("id").or_else(|| m.get("name")).and_then(|x| x.as_str()))
        .map(|s| s.trim_start_matches("models/").to_string())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url).to_string()
}

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s = c.to_string();
        cur = c.source();
    }
    s
}

/// Pull a readable message out of a provider's JSON error body.
fn api_error(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let v = if v.is_array() { v[0].clone() } else { v };
        for p in ["/error/message", "/message", "/error", "/detail"] {
            if let Some(s) = v.pointer(p).and_then(|x| x.as_str()) {
                return s.to_string();
            }
        }
    }
    body.chars().take(300).collect()
}

type Req = (String, Value, Vec<(&'static str, String)>);

fn anthropic_request(req: &ChatReq, key: Option<&str>) -> Result<Req> {
    let key = key.filter(|k| !k.is_empty()).ok_or_else(|| anyhow!("no API key set for this provider"))?;
    let messages: Vec<Value> = req
        .messages
        .iter()
        .filter(|m| !m.content.is_empty())
        .map(|m| {
            let content: Vec<Value> = m
                .content
                .iter()
                .map(|p| match p {
                    Part::Text { text } => json!({"type": "text", "text": text}),
                    Part::ToolUse { id, name, input } => json!({"type": "tool_use", "id": id, "name": name, "input": input}),
                    Part::ToolResult { tool_use_id, content, is_error } => {
                        json!({"type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error})
                    }
                })
                .collect();
            json!({"role": m.role, "content": content})
        })
        .collect();
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(8192),
        "system": [{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
        "stream": true,
    });
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req.tools.iter().map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters})).collect();
        body["tools"] = Value::Array(tools);
    }
    Ok((
        anthropic_url(&req.base_url, "messages"),
        body,
        vec![("x-api-key", key.to_string()), ("anthropic-version", "2023-06-01".into())],
    ))
}

fn openai_request(req: &ChatReq, key: Option<&str>) -> Req {
    let mut messages = vec![json!({"role": "system", "content": req.system})];
    for m in &req.messages {
        if m.role == "assistant" {
            let text: String = m.content.iter().filter_map(|p| if let Part::Text { text } = p { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
            let calls: Vec<Value> = m
                .content
                .iter()
                .filter_map(|p| match p {
                    Part::ToolUse { id, name, input } => Some(json!({"id": id, "type": "function", "function": {"name": name, "arguments": input.to_string()}})),
                    _ => None,
                })
                .collect();
            let mut msg = json!({"role": "assistant", "content": if text.is_empty() && !calls.is_empty() { Value::Null } else { Value::String(text) }});
            if !calls.is_empty() {
                msg["tool_calls"] = Value::Array(calls);
            }
            messages.push(msg);
        } else {
            // tool results become "tool" messages; any text goes in a user message after them
            let mut text = vec![];
            for p in &m.content {
                match p {
                    Part::ToolResult { tool_use_id, content, is_error } => {
                        let content = if *is_error { format!("ERROR: {content}") } else { content.clone() };
                        messages.push(json!({"role": "tool", "tool_call_id": tool_use_id, "content": content}));
                    }
                    Part::Text { text: t } => text.push(t.as_str()),
                    Part::ToolUse { .. } => {}
                }
            }
            if !text.is_empty() {
                messages.push(json!({"role": "user", "content": text.join("\n")}));
            }
        }
    }
    let mut body = json!({"model": req.model, "messages": messages, "stream": true});
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
            .collect();
        body["tools"] = Value::Array(tools);
    }
    let mut headers = vec![];
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        headers.push(("authorization", format!("Bearer {k}")));
    }
    if req.base_url.contains("openrouter.ai") {
        headers.push(("http-referer", "https://termx.kroombox.com".into()));
        headers.push(("x-title", "TermX".into()));
    }
    (join(&req.base_url, "chat/completions"), body, headers)
}

/// Server-sent events: buffers bytes and yields each event's `data` payload.
#[derive(Default)]
struct Sse {
    buf: Vec<u8>,
}
impl Sse {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        loop {
            let text = String::from_utf8_lossy(&self.buf);
            let Some((end, sep)) = text.find("\n\n").map(|i| (i, 2)).or_else(|| text.find("\r\n\r\n").map(|i| (i, 4))) else { break };
            let event = text[..end].to_string();
            self.buf.drain(..end + sep);
            let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(|l| l.strip_prefix(' ').unwrap_or(l)).collect();
            if !data.is_empty() {
                out.push(data.join("\n"));
            }
        }
        out
    }
}

/// Builds the final message from stream events.
#[derive(Default)]
struct Acc {
    /// content blocks by index: (kind, text-or-json, tool id, tool name)
    blocks: BTreeMap<u64, (String, String, String, String)>,
    stop: String,
    input_tokens: u64,
    output_tokens: u64,
}

impl Acc {
    fn anthropic_event(&mut self, v: &Value, on_text: &(dyn Fn(&str) + Send + Sync)) -> Result<()> {
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                let u = &v["message"]["usage"];
                self.input_tokens = u["input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let i = v["index"].as_u64().unwrap_or(0);
                let b = &v["content_block"];
                let kind = b["type"].as_str().unwrap_or("").to_string();
                let text = b["text"].as_str().unwrap_or("").to_string();
                if !text.is_empty() {
                    on_text(&text);
                }
                self.blocks.insert(i, (kind, text, b["id"].as_str().unwrap_or("").into(), b["name"].as_str().unwrap_or("").into()));
            }
            "content_block_delta" => {
                let i = v["index"].as_u64().unwrap_or(0);
                let d = &v["delta"];
                if let Some(b) = self.blocks.get_mut(&i) {
                    if let Some(t) = d["text"].as_str() {
                        b.1.push_str(t);
                        on_text(t);
                    } else if let Some(j) = d["partial_json"].as_str() {
                        b.1.push_str(j);
                    }
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    self.stop = s.to_string();
                }
                if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                    self.output_tokens = n;
                }
            }
            "error" => bail!("{}", v["error"]["message"].as_str().unwrap_or("model error")),
            _ => {}
        }
        Ok(())
    }

    fn openai_event(&mut self, v: &Value, on_text: &(dyn Fn(&str) + Send + Sync)) -> Result<()> {
        if let Some(e) = v.get("error") {
            bail!("{}", e["message"].as_str().unwrap_or("model error"));
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            self.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(self.input_tokens);
            self.output_tokens = u["completion_tokens"].as_u64().unwrap_or(self.output_tokens);
        }
        let Some(c) = v["choices"].get(0) else { return Ok(()) };
        let d = &c["delta"];
        if let Some(t) = d["content"].as_str().filter(|t| !t.is_empty()) {
            // text goes in block 0; tool calls use 1 + their index
            let b = self.blocks.entry(0).or_insert_with(|| ("text".into(), String::new(), String::new(), String::new()));
            b.1.push_str(t);
            on_text(t);
        }
        if let Some(calls) = d["tool_calls"].as_array() {
            for (n, call) in calls.iter().enumerate() {
                let i = 1 + call["index"].as_u64().unwrap_or(n as u64);
                let b = self.blocks.entry(i).or_insert_with(|| ("tool_use".into(), String::new(), String::new(), String::new()));
                if let Some(id) = call["id"].as_str().filter(|s| !s.is_empty()) {
                    b.2 = id.to_string();
                }
                if let Some(name) = call["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                    b.3.push_str(name);
                }
                if let Some(a) = call["function"]["arguments"].as_str() {
                    b.1.push_str(a);
                }
            }
        }
        if let Some(r) = c["finish_reason"].as_str() {
            self.stop = match r {
                "tool_calls" | "function_call" => "tool_use".into(),
                "length" => "max_tokens".into(),
                _ => "end_turn".into(),
            };
        }
        Ok(())
    }

    fn finish(self) -> ChatResp {
        let mut content = vec![];
        for (i, (kind, body, id, name)) in self.blocks {
            match kind.as_str() {
                "text" if !body.trim().is_empty() => content.push(Part::Text { text: body }),
                "tool_use" => {
                    let input = if body.trim().is_empty() { json!({}) } else { serde_json::from_str(&body).unwrap_or_else(|_| json!({"_raw": body})) };
                    let id = if id.is_empty() { format!("call_{i}_{}", uuid::Uuid::new_v4().simple()) } else { id };
                    content.push(Part::ToolUse { id, name, input });
                }
                _ => {}
            }
        }
        let has_tools = content.iter().any(|p| matches!(p, Part::ToolUse { .. }));
        let stop = if has_tools { "tool_use".to_string() } else if self.stop.is_empty() { "end_turn".into() } else { self.stop };
        ChatResp { content, stop_reason: stop, input_tokens: self.input_tokens, output_tokens: self.output_tokens }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(api: &str, raw: &str) -> ChatResp {
        let mut sse = Sse::default();
        let mut acc = Acc::default();
        let texts = std::sync::Mutex::new(String::new());
        let on = |t: &str| texts.lock().unwrap().push_str(t);
        // split mid-event to exercise buffering
        let (a, b) = raw.split_at(raw.len() / 2);
        for chunk in [a, b] {
            for d in sse.push(chunk.as_bytes()) {
                if d == "[DONE]" {
                    continue;
                }
                let v: Value = serde_json::from_str(&d).unwrap();
                if api == "anthropic" { acc.anthropic_event(&v, &on).unwrap() } else { acc.openai_event(&v, &on).unwrap() }
            }
        }
        acc.finish()
    }

    #[test]
    fn anthropic_stream_with_tool() {
        let raw = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Checking disk\"}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"run_command\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\": \\\"df\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\" -h\\\"}\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":30}}\n\n",
        );
        let r = feed("anthropic", raw);
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.input_tokens, 12);
        assert_eq!(r.content[0], Part::Text { text: "Checking disk".into() });
        assert_eq!(r.content[1], Part::ToolUse { id: "tu_1".into(), name: "run_command".into(), input: json!({"command": "df -h"}) });
    }

    #[test]
    fn openai_stream_with_tool() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Sure\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"run_command\",\"arguments\":\"{\\\"comm\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"and\\\":\\\"uptime\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let r = feed("openai", raw);
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.content[0], Part::Text { text: "Sure".into() });
        assert_eq!(r.content[1], Part::ToolUse { id: "c1".into(), name: "run_command".into(), input: json!({"command": "uptime"}) });
    }

    /// Serve one canned streaming response over real HTTP and run `chat` against it.
    async fn serve_once(body: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = s.read(&mut buf).await;
            let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(7) {
                s.write_all(chunk).await.unwrap();
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn chat_streams_over_http() {
        let base = serve_once(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n"
        ))
        .await;
        let req = ChatReq { api: "openai".into(), base_url: format!("{base}/v1"), model: "m".into(), system: "s".into(),
            messages: vec![Msg { role: "user".into(), content: vec![Part::Text { text: "hi".into() }] }], tools: vec![], max_tokens: None };
        let seen = std::sync::Mutex::new(String::new());
        let r = chat(&req, None, &|t| seen.lock().unwrap().push_str(t), &CancellationToken::new()).await.unwrap();
        assert_eq!(seen.lock().unwrap().as_str(), "Hello");
        assert_eq!(r.content, vec![Part::Text { text: "Hello".into() }]);
        assert_eq!((r.stop_reason.as_str(), r.input_tokens, r.output_tokens), ("end_turn", 5, 2));
    }

    #[tokio::test]
    async fn chat_reports_provider_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = s.read(&mut buf).await;
            let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
            let _ = s.write_all(format!("HTTP/1.1 401 Unauthorized\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes()).await;
        });
        let req = ChatReq { api: "anthropic".into(), base_url: format!("http://{addr}"), model: "m".into(), system: "s".into(), messages: vec![], tools: vec![], max_tokens: None };
        let e = chat(&req, Some("bad"), &|_| {}, &CancellationToken::new()).await.unwrap_err().to_string();
        assert!(e.contains("401") && e.contains("invalid x-api-key"), "{e}");
    }

    #[test]
    fn openai_request_maps_tool_results() {
        let req = ChatReq {
            api: "openai".into(),
            base_url: "https://api.openai.com/v1/".into(),
            model: "m".into(),
            system: "sys".into(),
            messages: vec![
                Msg { role: "user".into(), content: vec![Part::Text { text: "hi".into() }] },
                Msg { role: "assistant".into(), content: vec![Part::ToolUse { id: "c1".into(), name: "x".into(), input: json!({"a": 1}) }] },
                Msg { role: "user".into(), content: vec![Part::ToolResult { tool_use_id: "c1".into(), content: "ok".into(), is_error: false }] },
            ],
            tools: vec![],
            max_tokens: None,
        };
        let (url, body, h) = openai_request(&req, Some("k"));
        assert_eq!(url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(h[0].1, "Bearer k");
        let m = body["messages"].as_array().unwrap();
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], "{\"a\":1}");
        assert_eq!(m[3]["role"], "tool");
        assert_eq!(m[3]["tool_call_id"], "c1");
        assert_eq!(anthropic_url("https://api.anthropic.com/v1", "messages"), "https://api.anthropic.com/v1/messages");
    }
}
