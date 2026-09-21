---
title: Budget Governance Model
section: strategy
url: https://wiki.internal.example.com/strategy/budget-governance
path: Strategy / Budget Governance Model
updatedAt: 2025-05-20
---
# Budget Governance Model

This is the strategy behind budget approval, written upstream of the
product requirements that eventually implement it. It exists so that when
someone asks "why does the product require approval above $50k," there's
an answer that predates and outlives whatever the current UI happens to
show.

## Why approval gates exist at all

Uncontrolled mid-flight budget increases were the single largest source of
unplanned overspend before this policy existed. The gate isn't about
distrust of any one team — it's that a budget increase is a real-money
decision made under time pressure, and a second set of eyes catches
mistakes a single approver under deadline pressure won't.

## The approval chain (what product requirements must implement)

Any budget increase above a campaign's original cap must be approved by
the requesting team's budget owner. Increases above $50,000/month for a
single campaign additionally require sign-off from the Finance Governance
Council, which meets weekly — that threshold was set at the point where
weekly review cadence was still fast enough not to block real campaigns,
based on 2024 incident data.

For who currently holds the budget-owner role and how that assignment
works day to day, see [Governance Roles](https://notion.example.com/team/governance-roles),
maintained by the team.

## New campaign types

Enabling a new campaign type for an account requires approval from the
account's platform administrator, for the same reason: a new campaign type
often implies a new billing or targeting surface that hasn't been through
the same risk review as existing ones.

## Auditing

Every approval action is logged with the approver's identity, the amount
or change approved, and a timestamp. Seven-year retention is a finance
compliance requirement, not a product one — this predates and is stricter
than the product's own data retention defaults.
