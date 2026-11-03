// What Pantani knows about Passo. Shared by the ingest classifier and the Ask
// route so the two cannot drift apart.
//
// Source of truth is the Passo plan (claude.ai Passo Project, plan/PLAN.md and
// plan/decisions.md). When the plan changes, update this text and bump
// PASSO_CONTEXT_VERSION, then run scripts/reclassify.ts so the stored
// summaries, key insights and tags are rewritten against the new context.

export const PASSO_CONTEXT_VERSION = '2026-11-03b'

export const PASSO_CONTEXT = `Passo (The Passo Agency, passoagency.com) is a UK paid media service for Shopify brands. It uses whatever channels, formats and tools fit the brand and judges each on results: Meta, Google (Search, Shopping, Performance Max, Demand Gen, YouTube), Pinterest, TikTok, open-web display and anything else that works. It uses platform automation where it fits.

What Passo sells is judgement: one joined-up view of account set-up, measurement, creative, competitors and platform changes, with the reasoning, expected effect and test shown for every recommendation.

Who it serves: today any client it can win, mainly consulting work. The end state is Shopify subscription and repeat-purchase brands spending £20k to £200k a month, UK first, with France, Germany, the Nordics and the Netherlands later. For subscription brands it optimises to retained subscribers and payback, not first-order return.

The offer: a free Day 3 strategy report (strategy, a light health check of the ads, products, audience, channel mix, competitors, media plan and targets), then Observe (read-only access, monthly health checks, weekly recommendations the client acts on), then Activate (Passo makes the changes). Consulting projects (media brief, health check, annual review, strategy) are sold alongside.

How it measures: Shopify and the client's own data come before platform-reported numbers. Passo runs its own tests, geo holdouts included. Every report leads with Passo value: the extra revenue and savings a recommendation should deliver, and what changes delivered. Passo does not recommend brand search, keeps it out of acquisition cost, and reports it separately where a client runs it. Retention and remarketing media are allowed.

Every diagnosis and recommendation is organised by six pillars:
1. Strategy and positioning: messages, products, channel and budget allocation, seasonality, markets.
2. KPIs and metrics: unit economics, margin, CAC against LTV, payback, optimisation targets.
3. Data and tech: pixels, Conversions API, tags, consent, product feeds, data flows into Shopify, GA4 and the platforms.
4. Governance: account and campaign settings, structure, naming, automation, budgets, drift.
5. Creative: formats, variants, refresh rate, fatigue, messaging.
6. Validation, reporting and insights: tests, reporting against the client's own data, what drove each change.

Pantani is Jordan's knowledge bank of newsletters, videos, podcasts and documents. Its point of view goes into every Passo output, from the Day 3 report to weekly recommendations, wherever it differs from platform best practice or adds something new: especially new features, betas and tactics a coded health check would not know about.`
