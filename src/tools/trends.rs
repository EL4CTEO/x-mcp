use serde_json::{Value, json};

use super::schema::{field, int};
use super::*;
use crate::handler;
use crate::x::fields::TREND_FIELDS;
use crate::x::normalize;

pub fn actions() -> Vec<Action> {
    vec![
        Action {
            action: "by_location",
            title: "Trends by location",
            description: "Trending topics for a location identified by WOEID. Common WOEIDs: 1 = worldwide, 23424977 = United States, 23424975 = United Kingdom, 23424853 = Italy, 23424950 = Spain, 23424848 = India, 23424856 = Japan, 23424969 = Turkey, 23424775 = Canada, 23424900 = Mexico, 23424768 = Brazil. Returns trend names, post volumes and search URLs.",
            ann: READ,
            fields: vec![
                field("woeid", int(1, None))
                    .def(json!(1))
                    .desc("Where On Earth ID of the location. 1 = worldwide."),
                field("max_trends", int(1, Some(50)))
                    .def(json!(20))
                    .desc("Number of results to return (1-50)."),
            ],
            handler: handler!(by_location),
        },
        Action {
            action: "personalized",
            title: "Personalized trends",
            description: "Trending topics personalised for the authenticated account (based on follows, location and activity). Requires user auth. Complements by_location, which is location-based. Returns trend names, post counts, categories and how long each trend has been trending when X provides them.",
            ann: READ,
            fields: vec![],
            handler: handler!(personalized),
        },
    ]
}

fn trends(res: &XResponse) -> Vec<Value> {
    res.data
        .as_array()
        .map(|l| l.iter().map(normalize::trend).collect())
        .unwrap_or_default()
}

async fn by_location(c: &Ctx, a: &Args, _: &Call) -> Out {
    let woeid = a.v("woeid").cloned().unwrap_or(json!(1));
    let request = XRequest::get(format!("/2/trends/by/woeid/{woeid}"))
        .q("max_trends", a.u("max_trends"))
        .q("trend.fields", TREND_FIELDS)
        .cache_ttl(60_000);
    let res = c.req(request).await?;
    Ok(obj! { "woeid" => woeid, "data" => trends(&res) }.into())
}

async fn personalized(c: &Ctx, _: &Args, _: &Call) -> Out {
    let request = XRequest::get("/2/users/personalized_trends")
        .user()
        .q(
            "personalized_trend.fields",
            "trend_name,post_count,category,trending_since",
        )
        .cache_ttl(60_000);
    let res = c.req(request).await?;
    Ok(obj! { "data" => trends(&res) }.into())
}
