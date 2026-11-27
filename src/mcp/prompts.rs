//! Prompt templates for the multi-step workflows agents get wrong most often.

use serde_json::{Map, Value, json};

const PREAMBLE: &str = "You are operating the X (Twitter) MCP server. Tools are grouped by domain and each call takes an \"action\" field plus that action's parameters (for example x_posts with action \"search\"). Prefer batched reads (x_posts \"get_many\", x_users \"get_many\") over loops, use next_token for pagination, and keep max_results small unless the user asks for breadth. Never invent post or user ids: resolve handles with x_users \"get\" first. Public actions (posting, replying, liking, following, DMs) are visible to real people — confirm intent before performing them, and never run bulk engagement or spam-like behaviour.";

struct Arg {
    name: &'static str,
    description: &'static str,
    required: bool,
}

struct Prompt {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    args: &'static [Arg],
}

const PROMPTS: &[Prompt] = &[
    Prompt {
        name: "draft_thread",
        title: "Draft and publish a thread",
        description: "Plan a thread on a topic, check it against recent conversation, and publish it as chained posts.",
        args: &[
            Arg {
                name: "topic",
                description: "What the thread is about.",
                required: true,
            },
            Arg {
                name: "audience",
                description: "Target audience, e.g. \"indie hackers\" or \"ML engineers\".",
                required: false,
            },
            Arg {
                name: "tone",
                description: "Voice, e.g. analytical, punchy, friendly.",
                required: false,
            },
            Arg {
                name: "posts",
                description: "Target number of posts (default 5).",
                required: false,
            },
        ],
    },
    Prompt {
        name: "reply_triage",
        title: "Triage mentions and draft replies",
        description: "Review recent mentions, classify them, and draft replies that add value without spam.",
        args: &[
            Arg {
                name: "username",
                description: "Account whose mentions to triage (defaults to the authenticated account).",
                required: false,
            },
            Arg {
                name: "limit",
                description: "How many mentions to review (default 20).",
                required: false,
            },
        ],
    },
    Prompt {
        name: "account_report",
        title: "Account performance report",
        description: "Analyse a public account: profile, recent posts, engagement, and what is working.",
        args: &[
            Arg {
                name: "username",
                description: "Handle to analyse (without @).",
                required: true,
            },
            Arg {
                name: "days",
                description: "Lookback window in days (default 7).",
                required: false,
            },
        ],
    },
    Prompt {
        name: "summarize_conversation",
        title: "Summarize a conversation",
        description: "Read a thread and produce a neutral summary with key claims and open questions.",
        args: &[Arg {
            name: "tweet_id",
            description: "Any post id in the conversation.",
            required: true,
        }],
    },
];

pub fn list() -> Value {
    let prompts: Vec<Value> = PROMPTS
        .iter()
        .map(|p| {
            let args: Vec<Value> =
                p.args.iter().map(|a| json!({ "name": a.name, "description": a.description, "required": a.required })).collect();
            json!({ "name": p.name, "title": p.title, "description": p.description, "arguments": args })
        })
        .collect();
    json!({ "prompts": prompts })
}

fn message(description: String, lines: Vec<String>) -> Value {
    message_with(description, lines, true)
}

fn message_with(description: String, lines: Vec<String>, blank: bool) -> Value {
    let gap = if blank { vec![String::new()] } else { vec![] };
    let text = std::iter::once(PREAMBLE.to_owned())
        .chain(gap)
        .chain(lines)
        .collect::<Vec<_>>()
        .join("\n");
    json!({ "description": description, "messages": [{ "role": "user", "content": { "type": "text", "text": text } }] })
}

/// `prompts/get`. Errors are `(code, message)` JSON-RPC errors.
pub fn get(name: &str, args: &Map<String, Value>) -> Result<Value, (i64, String)> {
    let Some(prompt) = PROMPTS.iter().find(|p| p.name == name) else {
        return Err((-32602, format!("Prompt {name} not found")));
    };
    let arg = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    for a in prompt.args.iter().filter(|a| a.required) {
        if arg(a.name).is_none() {
            return Err((
                -32602,
                format!("Missing required argument \"{}\" for prompt {name}", a.name),
            ));
        }
    }
    let req = |k: &str| arg(k).unwrap_or_default();
    Ok(match name {
        "draft_thread" => {
            let posts = arg("posts").unwrap_or_else(|| "5".into());
            let topic = req("topic");
            let mut lines = vec![format!("Draft a {posts}-post thread about: {topic}.")];
            if let Some(a) = arg("audience") {
                lines.push(format!("Audience: {a}."));
            }
            if let Some(t) = arg("tone") {
                lines.push(format!("Tone: {t}."));
            }
            lines.extend([
                "Workflow:",
                "1. Call x_posts with action \"search\" and a narrow query (add -is:retweet), max_results 20, to learn what has already been said recently. Do not copy existing posts.",
                "2. Identify a specific angle and a concrete takeaway for each post. Hooks should state a claim, not a greeting.",
                "3. Write each post under 280 characters, numbered implicitly by the thread structure. No hashtags unless the user asked. Do not fabricate statistics or quotes; if you need data, say what you would verify.",
                "4. Show the full draft to the user and ask for approval before publishing.",
                "5. After approval, publish with x_posts action \"create_thread\". Report the returned ids and the root URL.",
            ].map(String::from));
            message_with(
                format!("Draft a {posts}-post thread about {topic}"),
                lines,
                false,
            )
        }
        "reply_triage" => {
            let limit = arg("limit").unwrap_or_else(|| "20".into());
            let who = arg("username")
                .map(|u| format!("@{u}"))
                .unwrap_or_else(|| "the authenticated account".into());
            message(format!("Triage {limit} recent mentions"), vec![
                format!("Review the latest {limit} mentions of {who} with x_timelines action \"mentions\"."),
                "Classify each mention as: question, praise, criticism, spam, or conversation starter. Note the author follower count and whether they are verified.".into(),
                "Draft a reply only for questions and genuine conversation starters. Replies must be specific to the post, under 280 characters, and free of generic filler (\"Thanks for sharing!\"). Do not reply to spam.".into(),
                "Present a table of mention → classification → suggested reply, then wait for approval. Publish approved replies with x_posts action \"create\" and reply_to set to the mention id, spacing them out to stay within rate limits.".into(),
            ])
        }
        "account_report" => {
            let user = req("username");
            let days = arg("days").unwrap_or_else(|| "7".into());
            message(format!("Report on @{user}"), vec![
                format!("Build a concise performance report for @{user} over the last {days} days."),
                format!("Steps: x_users action \"get\" for profile metrics; x_timelines action \"user\" with max_results 50 and a start_time covering the window; optionally x_posts action \"search\" with `from:{user} -is:retweet` for posts older than the timeline window."),
                "Compute: posting cadence, median and top likes/reposts/replies, best-performing format (text, media, thread, quote), and the 2-3 recurring themes with the highest engagement.".into(),
                "Call out anomalies (viral outlier, reply-heavy post) and give three concrete, non-generic recommendations for the next week. Use exact numbers; state the sample size and the lookback window. Do not infer audience demographics that the API does not return.".into(),
            ])
        }
        _ => {
            let id = req("tweet_id");
            message(format!("Summarize conversation {id}"), vec![
                format!("Summarize the conversation around post {id} using x_posts action \"thread\"."),
                "Produce: (1) one-sentence thesis, (2) bullet timeline of the main contributions with authors, (3) claims that are asserted without evidence, (4) open questions or disagreements, (5) a two-sentence neutral takeaway.".into(),
                "Attribute every claim to its author handle. If the conversation is truncated (the tool reports truncated: true or older than the 7-day search window), say so explicitly instead of guessing.".into(),
            ])
        }
    })
}
