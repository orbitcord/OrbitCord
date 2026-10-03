use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl WindowState {
    fn validate(&self) -> Result<(), String> {
        if !(520..=16384).contains(&self.width) || !(400..=16384).contains(&self.height) {
            return Err("invalid window dimensions".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

pub struct Backend {
    state_path: PathBuf,
}

impl Backend {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            state_path: data_dir.join("window-state.json"),
        }
    }

    pub fn respond(&mut self, line: &str) -> Value {
        let request: Request = match serde_json::from_str(line) {
            Ok(request) => request,
            Err(_) => return json!({ "id": null, "error": "invalid request" }),
        };
        match self.execute(&request.command, request.args) {
            Ok(result) => json!({ "id": request.id, "result": result }),
            Err(error) => json!({ "id": request.id, "error": error }),
        }
    }

    fn execute(&mut self, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "get_window_state" => {
                let state = fs::read(&self.state_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<WindowState>(&bytes).ok())
                    .filter(|state| state.validate().is_ok());
                serde_json::to_value(state).map_err(|e| e.to_string())
            }
            "save_window_state" => {
                let state: WindowState = serde_json::from_value(args).map_err(|e| e.to_string())?;
                state.validate()?;
                let parent = self.state_path.parent().ok_or("invalid state path")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                fs::write(
                    &self.state_path,
                    serde_json::to_vec(&state).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "notify" => {
                let title = text(&args, "title", 256)?;
                let body = text(&args, "body", 4096)?;
                std::thread::spawn(move || {
                    if let Err(error) = notify_rust::Notification::new()
                        .summary(&title)
                        .body(&body)
                        .show()
                    {
                        eprintln!("[lowcord] notification failed: {error}");
                    }
                });
                Ok(Value::Null)
            }
            "open_external" => {
                let url = external_url(&text(&args, "url", 8192)?)?;
                open::that_detached(url.as_str()).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "log" => {
                eprintln!("[lowcord] {}", text(&args, "message", 4096)?);
                Ok(Value::Null)
            }
            _ => Err("unknown command".into()),
        }
    }
}

fn text(args: &Value, key: &str, limit: usize) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))?;
    if value.len() > limit {
        return Err(format!("{key} is too long"));
    }
    Ok(value.to_owned())
}

fn external_url(input: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(input).map_err(|_| "invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only HTTP(S) links without credentials are allowed".into());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_executable_links_and_url_credentials() {
        for url in [
            "file:///tmp/video.mp4",
            "javascript:alert(1)",
            "discord://invite/foo",
            "https://u:p@example.com",
        ] {
            assert!(external_url(url).is_err());
        }
        assert!(external_url("https://example.com/watch?v=1").is_ok());
    }

    #[test]
    fn state_round_trip_and_invalid_state_does_not_overwrite() {
        let dir = std::env::temp_dir().join(format!("lowcord-state-test-{}", std::process::id()));
        let mut backend = Backend::new(dir.clone());
        let state = json!({"x": -900, "y": 100, "width": 1280, "height": 800, "maximized": false});
        assert!(backend.execute("save_window_state", state.clone()).is_ok());
        assert!(backend
            .execute("save_window_state", json!({"width": 0}))
            .is_err());
        assert_eq!(
            backend.execute("get_window_state", Value::Null).unwrap(),
            state
        );
        fs::write(&backend.state_path, "broken").unwrap();
        assert_eq!(
            backend.execute("get_window_state", Value::Null).unwrap(),
            Value::Null
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_request_does_not_kill_protocol() {
        let mut backend = Backend::new(std::env::temp_dir());
        assert!(backend.respond("broken")["error"].is_string());
        let response = backend.respond(r#"{"id":7,"command":"shell"}"#);
        assert_eq!(response["id"], 7);
        assert_eq!(response["error"], "unknown command");
    }
}
