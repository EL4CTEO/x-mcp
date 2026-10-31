import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SYSTEM_PREAMBLE =
  'You are operating the X (Twitter) MCP server. Tools are grouped by domain and each call takes an "action" field plus that action\'s parameters (for example x_posts with action "search"). Prefer batched reads (x_posts "get_many", x_users "get_many") over loops, use next_token for pagination, and keep max_results small unless the user asks for breadth. Never invent post or user ids: resolve handles with x_users "get" first. Public actions (posting, replying, liking, following, DMs) are visible to real people — confirm intent before performing them, and never run bulk engagement or spam-like behaviour.';

function text(value: string) {
  return { type: 'text' as const, text: value };
}

/** Prompt templates encode the multi-step workflows agents get wrong most often. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'draft_thread',
    {
      title: 'Draft and publish a thread',
      description: 'Plan a thread on a topic, check it against recent conversation, and publish it as chained posts.',
      argsSchema: {
        topic: z.string().describe('What the thread is about.'),
        audience: z.string().optional().describe('Target audience, e.g. "indie hackers" or "ML engineers".'),
        tone: z.string().optional().describe('Voice, e.g. analytical, punchy, friendly.'),
        posts: z.string().optional().describe('Target number of posts (default 5).'),
      },
    },
    ({ topic, audience, tone, posts }) => ({
      description: `Draft a ${posts ?? '5'}-post thread about ${topic}`,
      messages: [
        {
          role: 'user',
          content: text(
            [
              SYSTEM_PREAMBLE,
              '',
              `Draft a ${posts ?? '5'}-post thread about: ${topic}.`,
              audience ? `Audience: ${audience}.` : '',
              tone ? `Tone: ${tone}.` : '',
              '',
              'Workflow:',
              '1. Call x_posts with action "search" and a narrow query (add -is:retweet), max_results 20, to learn what has already been said recently. Do not copy existing posts.',
              '2. Identify a specific angle and a concrete takeaway for each post. Hooks should state a claim, not a greeting.',
              '3. Write each post under 280 characters, numbered implicitly by the thread structure. No hashtags unless the user asked. Do not fabricate statistics or quotes; if you need data, say what you would verify.',
              '4. Show the full draft to the user and ask for approval before publishing.',
              '5. After approval, publish with x_posts action "create_thread". Report the returned ids and the root URL.',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    'reply_triage',
    {
      title: 'Triage mentions and draft replies',
      description: 'Review recent mentions, classify them, and draft replies that add value without spam.',
      argsSchema: {
        username: z.string().optional().describe('Account whose mentions to triage (defaults to the authenticated account).'),
        limit: z.string().optional().describe('How many mentions to review (default 20).'),
      },
    },
    ({ username, limit }) => ({
      description: `Triage ${limit ?? '20'} recent mentions`,
      messages: [
        {
          role: 'user',
          content: text(
            [
              SYSTEM_PREAMBLE,
              '',
              `Review the latest ${limit ?? '20'} mentions of ${username ? `@${username}` : 'the authenticated account'} with x_timelines action "mentions".`,
              'Classify each mention as: question, praise, criticism, spam, or conversation starter. Note the author follower count and whether they are verified.',
              'Draft a reply only for questions and genuine conversation starters. Replies must be specific to the post, under 280 characters, and free of generic filler ("Thanks for sharing!"). Do not reply to spam.',
              'Present a table of mention → classification → suggested reply, then wait for approval. Publish approved replies with x_posts action "create" and reply_to set to the mention id, spacing them out to stay within rate limits.',
            ].join('\n'),
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    'account_report',
    {
      title: 'Account performance report',
      description: 'Analyse a public account: profile, recent posts, engagement, and what is working.',
      argsSchema: {
        username: z.string().describe('Handle to analyse (without @).'),
        days: z.string().optional().describe('Lookback window in days (default 7).'),
      },
    },
    ({ username, days }) => ({
      description: `Report on @${username}`,
      messages: [
        {
          role: 'user',
          content: text(
            [
              SYSTEM_PREAMBLE,
              '',
              `Build a concise performance report for @${username} over the last ${days ?? '7'} days.`,
              'Steps: x_users action "get" for profile metrics; x_timelines action "user" with max_results 50 and a start_time covering the window; optionally x_posts action "search" with `from:${username} -is:retweet` for posts older than the timeline window.',
              'Compute: posting cadence, median and top likes/reposts/replies, best-performing format (text, media, thread, quote), and the 2-3 recurring themes with the highest engagement.',
              'Call out anomalies (viral outlier, reply-heavy post) and give three concrete, non-generic recommendations for the next week. Use exact numbers; state the sample size and the lookback window. Do not infer audience demographics that the API does not return.',
            ].join('\n'),
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    'summarize_conversation',
    {
      title: 'Summarize a conversation',
      description: 'Read a thread and produce a neutral summary with key claims and open questions.',
      argsSchema: {
        tweet_id: z.string().describe('Any post id in the conversation.'),
      },
    },
    ({ tweet_id }) => ({
      description: `Summarize conversation ${tweet_id}`,
      messages: [
        {
          role: 'user',
          content: text(
            [
              SYSTEM_PREAMBLE,
              '',
              `Summarize the conversation around post ${tweet_id} using x_posts action "thread".`,
              'Produce: (1) one-sentence thesis, (2) bullet timeline of the main contributions with authors, (3) claims that are asserted without evidence, (4) open questions or disagreements, (5) a two-sentence neutral takeaway.',
              'Attribute every claim to its author handle. If the conversation is truncated (the tool reports truncated: true or older than the 7-day search window), say so explicitly instead of guessing.',
            ].join('\n'),
          ),
        },
      ],
    }),
  );
}
