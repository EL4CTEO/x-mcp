//! Default field and expansion sets. X bills per post returned, so we ask
//! for what an agent needs and skip the expensive extras.

use super::client::XRequest;

pub const TWEET_FIELDS: &str = "attachments,author_id,conversation_id,created_at,edit_history_tweet_ids,entities,id,in_reply_to_user_id,lang,note_tweet,possibly_sensitive,public_metrics,referenced_tweets,reply_settings,source,text";
pub const TWEET_EXPANSIONS: &str = "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys,attachments.poll_ids";
pub const USER_FIELDS: &str = "created_at,description,entities,id,location,name,pinned_tweet_id,profile_image_url,protected,public_metrics,url,username,verified,verified_type";
pub const USER_EXPANSIONS: &str = "pinned_tweet_id";
pub const MEDIA_FIELDS: &str = "alt_text,duration_ms,height,media_key,preview_image_url,public_metrics,type,url,variants,width";
pub const POLL_FIELDS: &str = "duration_minutes,end_datetime,id,options,voting_status";
pub const LIST_FIELDS: &str =
    "created_at,description,follower_count,id,member_count,name,owner_id,private";
pub const SPACE_FIELDS: &str = "created_at,creator_id,ended_at,host_ids,id,is_ticketed,lang,participant_count,scheduled_start,started_at,state,title,updated_at";
pub const TREND_FIELDS: &str = "trend_name,tweet_count";
pub const DM_EVENT_FIELDS: &str = "attachments,created_at,dm_conversation_id,id,sender_id,text";
pub const DM_EVENT_EXPANSIONS: &str = "attachments.media_keys,sender_id";

/// Query fragments, so every tool asks for the same fields.
pub trait Fields: Sized {
    fn posts(self) -> Self;
    fn users(self) -> Self;
    fn lists(self) -> Self;
    fn spaces(self) -> Self;
    fn dms(self) -> Self;
}

impl Fields for XRequest {
    fn posts(self) -> Self {
        self.qs(&[
            ("tweet.fields", TWEET_FIELDS),
            ("expansions", TWEET_EXPANSIONS),
            ("user.fields", USER_FIELDS),
            ("media.fields", MEDIA_FIELDS),
            ("poll.fields", POLL_FIELDS),
        ])
    }
    fn users(self) -> Self {
        self.qs(&[
            ("user.fields", USER_FIELDS),
            ("expansions", USER_EXPANSIONS),
        ])
    }
    fn lists(self) -> Self {
        self.qs(&[("list.fields", LIST_FIELDS), ("user.fields", USER_FIELDS)])
    }
    fn spaces(self) -> Self {
        self.qs(&[("space.fields", SPACE_FIELDS), ("user.fields", USER_FIELDS)])
    }
    fn dms(self) -> Self {
        self.qs(&[
            ("dm_event.fields", DM_EVENT_FIELDS),
            ("expansions", DM_EVENT_EXPANSIONS),
            ("media.fields", MEDIA_FIELDS),
        ])
    }
}
