---
title: Campaign Budgets
section: product-docs
url: /docs/campaigns/budgets/
path: Product Docs / Campaigns / Budgets
updatedAt: 2025-06-01
---
# Campaign Budgets

Every campaign is assigned a monthly budget cap when it is created. Spend is
tracked daily against that cap, and the campaign pauses automatically once
100% of the cap has been spent for the period.

## Daily pacing

Budget is spread evenly across the days remaining in the campaign's flight.
If a campaign underspends on a given day, the remaining amount is
redistributed across the rest of the flight rather than carried over past
the flight's end date.

## Increasing a budget mid-flight

Budget increases above the original cap require approval before they take
effect. See the [Budget Governance Model](https://wiki.internal.example.com/strategy/budget-governance)
for the policy behind approval thresholds and how the approval chain works.
Requests submitted without the required approval are held in a pending
state and do not spend.

## Currency and rounding

All budgets are stored in the account's billing currency. Daily pacing
amounts are rounded down to the nearest cent; any rounding remainder
accumulates and is spent on the final day of the flight.
