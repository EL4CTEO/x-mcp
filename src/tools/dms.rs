use serde_json::{Value, json};

use super::schema::{Ty, array, field, text};
use super::*;
use crate::handler;
use crate::util::encode_component;
use crate::x::fields::Fields;
use crate::x::normalize;

fn message() -> Vec<Field> {
    vec![
        field("text", text(1, 10_000)).desc("Message text."),
        field("media_id", digits())
            .opt()
            .desc("Optional media id uploaded with category dm_image or dm_video."),
    ]
}

fn conversation_id() -> Field {
    field("conversation_id", text(1, 64))
        .desc("Conversation id from a DM event (dm_conversation_id).")
}

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "send",
            title: "Send a Direct Message",
            description: "Send a DM to a user, creating the 1:1 conversation if needed. Requires user auth with dm.write and the users.read scope. DMs are private: confirm the recipient and content before sending. Media must be uploaded first with x_media action \"upload\" using category dm_image/dm_video.",
            ann: SEND,
            fields: fields(vec![user_ref(), message()]),
            handler: handler!(send),
        },
        Action {
            action: "send_to_conversation",
            title: "Send a DM to a conversation",
            description: "Send a message to an existing DM conversation by conversation id. Requires user auth with dm.write. Use action \"events\" to discover conversation ids.",
            ann: SEND,
            fields: fields(vec![vec![conversation_id()], message()]),
            handler: handler!(send_to_conversation),
        },
        Action {
            action: "events",
            title: "List DM events",
            description: "Recent Direct Message events across all conversations, newest first (1-100 per page). Requires user auth with dm.read. Use event_types to filter (e.g. MessageCreate, ParticipantsJoin).",
            ann: READ,
            fields: vec![
                max_results(1, 100, 50),
                next_token(),
                field("event_types", array(Ty::Str { min: Some(1), max: None, pattern: None, url: false }, None, None))
                    .opt()
                    .desc("Filter by event type, e.g. MessageCreate, ParticipantsJoin, ParticipantsLeave."),
            ],
            handler: handler!(events),
        },
        Action {
            action: "conversation",
            title: "Read a DM conversation",
            description: "Messages in one DM conversation, newest first (1-100 per page). Requires user auth with dm.read.",
            ann: READ,
            fields: vec![conversation_id(), max_results(1, 100, 50), next_token()],
            handler: handler!(conversation),
        },
        Action {
            action: "with_user",
            title: "Read the DM conversation with a user",
            description: "Messages exchanged with one user, newest first (1-100 per page). Resolves a username to the participant id automatically. Requires user auth with dm.read.",
            ann: READ,
            fields: fields(vec![user_ref(), vec![max_results(1, 100, 50), next_token()]]),
            handler: handler!(with_user),
        },
        Action {
            action: "delete",
            title: "Delete a DM event",
            description: "Delete a Direct Message event sent by the authenticated account. Requires user auth with dm.write. The message is removed from the conversation for both parties.",
            ann: DESTROY,
            fields: vec![field("event_id", digits()).desc("Numeric DM event id.")],
            handler: handler!(delete),
        },
    ]
}

fn body(a: &Args) -> Value {
    let mut body = obj! { "text" => a.owned("text") };
    if let Some(id) = a.s("media_id") {
        body.insert("attachments".into(), json!([{ "media_id": id }]));
    }
    Value::Object(body)
}

async fn send(c: &Ctx, a: &Args, _: &Call) -> Out {
    let participant = resolve_target(c, a.s("user_id"), a.s("username")).await?;
    let res = c
        .req(
            XRequest::post(format!("/2/dm_conversations/with/{participant}/messages"))
                .user()
                .body(body(a)),
        )
        .await?;
    Ok(obj! {
        "sent" => true,
        "participant_id" => participant,
        "conversation_id" => res.data_str("dm_conversation_id"),
        "event_id" => res.data_str("dm_event_id"),
        "text" => a.owned("text"),
    }
    .into())
}

async fn send_to_conversation(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("conversation_id");
    let res = c
        .req(
            XRequest::post(format!(
                "/2/dm_conversations/{}/messages",
                encode_component(id)
            ))
            .user()
            .body(body(a)),
        )
        .await?;
    Ok(obj! {
        "sent" => true,
        "conversation_id" => res.data_str("dm_conversation_id").unwrap_or_else(|| id.to_owned()),
        "event_id" => res.data_str("dm_event_id"),
        "text" => a.owned("text"),
    }
    .into())
}

fn page(a: &Args, path: String) -> XRequest {
    XRequest::get(path)
        .user()
        .dms()
        .q("max_results", a.u("max_results"))
        .q("pagination_token", a.s("next_token"))
        .no_cache()
}

async fn events(c: &Ctx, a: &Args, _: &Call) -> Out {
    let res = c
        .req(page(a, "/2/dm_events".into()).q("event_types", a.joined("event_types")))
        .await?;
    Ok(normalize::dm_events(&res.payload()).into())
}

async fn conversation(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("conversation_id");
    let res = c
        .req(page(
            a,
            format!("/2/dm_conversations/{}/dm_events", encode_component(id)),
        ))
        .await?;
    let mut out = obj! { "conversation_id" => id };
    out.extend(normalize::dm_events(&res.payload()));
    Ok(out.into())
}

async fn with_user(c: &Ctx, a: &Args, _: &Call) -> Out {
    let participant = resolve_target(c, a.s("user_id"), a.s("username")).await?;
    let res = c
        .req(page(
            a,
            format!("/2/dm_conversations/with/{participant}/dm_events"),
        ))
        .await?;
    let mut out = obj! { "participant_id" => participant };
    out.extend(normalize::dm_events(&res.payload()));
    Ok(out.into())
}

async fn delete(c: &Ctx, a: &Args, _: &Call) -> Out {
    let id = a.req("event_id");
    let res = c
        .req(XRequest::delete(format!("/2/dm_events/{id}")).user())
        .await?;
    Ok(obj! { "deleted" => res.data_true("deleted"), "event_id" => id }.into())
}
