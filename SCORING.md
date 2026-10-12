# Scoring

Scores are computed by code, not by a model. Rules: `src/domain/scoring/config.ts`. Logic: `src/domain/scoring/engine.ts`. Tests: `tests/scoring.test.ts`.

## Product scores (0–100 each)

A product's score is the **sum of the points of every rule that fires, capped at 100**. Each fired rule is stored as a reason:

```json
{ "ruleId": "sb.no_sms", "points": 25, "label": "No SMS response within 60 minutes",
  "kind": "OBSERVED", "confidence": "HIGH", "evidence": [{ "type": "interaction", "id": "…" }] }
```

Weights and thresholds are editable in **Settings → Scoring rules**. A weight of 0 turns a rule off. Saving re-scores every dealership.

### SummaryBot
| Rule | Points | Fires when |
|---|---|---|
| `sb.no_sms` | 25 | A test was submitted ≥ 1 hour ago and no SMS arrived within 60 minutes |
| `sb.slow_response` | 20 | First response took over 15 minutes (or none after 15 minutes) |
| `sb.no_response_1h` | 30 | No response on any channel within 1 hour |
| `sb.generic_email` | 10 | An automated email that doesn't reference the vehicle and isn't personalised *(inference)* |
| `sb.chat_failed` | 10 | A logged chat test found the chat not working, or quality under 40 |
| `sb.no_follow_up` | 15 | 72 hours passed (or the window closed) with one response or fewer |
| `sb.forms_no_chat` | 5 | Lead forms exist but there is no chat *(inference, low confidence)* |

Most SummaryBot rules need a controlled test. Before one runs, SummaryBot stays near zero by design: nothing is claimed about follow-up that hasn't been measured.

### Inventory Outreach
| Rule | Points | Fires when |
|---|---|---|
| `io.large_inventory` | 15 | Inventory ≥ 300 vehicles |
| `io.high_movement` | 15 | ≥ 10% of listings changed between two snapshots at least 2 days apart |
| `io.no_alerts` | 20 | Inventory pages were scanned and no alert sign-up was found |
| `io.bdc_hiring` | 20 | Recent BDC hiring signal |
| `io.internet_sales_hiring` | 15 | Recent internet-sales hiring signal |
| `io.crm_hiring` | 10 | Recent CRM or sales hiring signal |
| `io.inventory_ads` | 15 | Recent advertising-activity signal |

### Service Bot
| Rule | Points | Fires when |
|---|---|---|
| `sv.poor_scheduler` | 20 | No online scheduler, phone-only, form-only, or a scheduler form with ≥ 8 fields |
| `sv.no_service_chat` | 15 | No chat on the service page |
| `sv.no_sms` | 15 | No text option visible on service pages |
| `sv.complaints` | 20 | Service-scheduling-complaints signal |
| `sv.service_hiring` | 15 | Recent service hiring signal |
| `sv.large_service` | 15 | Large-service-operation signal |

### Social Automation
| Rule | Points | Fires when |
|---|---|---|
| `so.high_activity` | 15 | ≥ 20 posts in 30 days across platforms |
| `so.inventory_promoted` | 15 | ≥ 8 inventory posts in 30 days |
| `so.customer_questions` | 20 | ≥ 5 customer questions observed |
| `so.unanswered` | 25 | ≥ 3 questions apparently unanswered |
| `so.marketing_hiring` | 10 | Recent marketing or social-media hiring signal |
| `so.ads` | 15 | Ad activity observed |

Social rules need a social observation, which is operator-entered in this version.

"Recent" = within `signalRecencyDays` (default 60).

## Overall priority (0–100)

| Component | Max | How |
|---|---|---|
| Product opportunity | 50 | best score × 0.4 + second-best × 0.1 |
| Buying / budget signals | 15 | 5 per distinct recent signal type |
| Evidence confidence | 15 | points-weighted share of the top product's reasons that are high-confidence observations (HIGH 1.0, MEDIUM 0.6, LOW 0.3; inferences × 0.7) |
| Group value | 10 | rooftops in group: 2–4 → 4, 5–9 → 7, 10+ → 10 |
| Recency | 10 | newest evidence ≤ 7d → 10, ≤ 14d → 8, ≤ 30d → 5, ≤ 60d → 2 |

If no product scored, priority is 0. The breakdown is stored on the dealership and shown on its page ("How the priority is built"). An operator can set a manual priority that wins in lists; the computed score is still shown.

## Group score

`avg(rooftop priority) × 0.5 + max × 0.3 + 5 per systemic problem (max 15) + size bonus (2+ → 3, 5+ → 6, 10+ → 10)`, capped at 100. A problem is systemic when the same rule fired at ≥ 2 rooftops and ≥ 40% of those scanned.

## Worked example

A test was submitted 3 hours ago. One automated email arrived at 18 minutes. No SMS.

```
SummaryBot: 55
  +25  No SMS response within 60 minutes     observed · high   → test
  +20  First response took over 15 minutes   observed · high   → test
  +10  Generic automated email               inference · medium → response
```

This exact case is asserted in `tests/pipeline.integration.test.ts`.
