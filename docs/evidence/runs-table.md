| run | module | candidate | planner | verdict | seeded truth | correct | experiments | rejected | tokens | min |
|---|---|---|---|---|---|---|---|---|---|---|
| 4ff0dd03 | alertscenario | v1-reviewed | baseline | pass | clean candidate | yes | 4 | 0 | 0 | 6.5 |
| 08a4a874 | metriccontract | v1 | baseline | fail | clean candidate | no | 8 | 0 | 0 | 0.1 |
| 0ca28d2d | metriccontract | v2 | baseline | fail | seeded: metric_present | yes | 8 | 0 | 0 | 0.2 |
| ee142124 | metriccontract | v3 | baseline | fail | seeded: required_labels | yes | 8 | 0 | 0 | 0.3 |
| 8a96eab1 | metriccontract | v4 | baseline | inconclusive | seeded: cardinality_cap | no | 8 | 0 | 0 | 0.3 |
| fcace26d | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | no | 8 | 0 | 0 | 0.4 |
| de527002 | routereplay | v1-reviewed | baseline | inconclusive | clean candidate | no | 0 | 0 | 0 | 0.9 |
| ae0de0e3 | routereplay | v2-candidate | baseline | inconclusive | seeded: routed_to_intended_receiver | no | 0 | 0 | 0 | 0.9 |
| 0a740900 | routereplay | v3-candidate | baseline | inconclusive | seeded: grouped_by_team | no | 0 | 0 | 0 | 0.9 |
| ce1e2501 | alertscenario | v4-candidate | baseline | pass | seeded: short_spike_does_not_fire | no | 4 | 0 | 0 | 6.8 |
| 77e2b45f | alertscenario | v4-candidate | agent | inconclusive | seeded: short_spike_does_not_fire | no | 4 | 6 | 11649 | 9.5 |
| 905856b6 | metriccontract | v1 | baseline | pass | clean candidate | yes | 4 | 0 | 0 | 0.1 |
| a1ed8bd4 | metriccontract | v2 | baseline | fail | seeded: metric_present | yes | 4 | 0 | 0 | 0.2 |
| 965c3a22 | metriccontract | v3 | baseline | fail | seeded: required_labels | yes | 4 | 0 | 0 | 0.3 |
| 933c5ed2 | metriccontract | v4 | baseline | fail | seeded: cardinality_cap | yes | 4 | 0 | 0 | 0.4 |
| 56f3378d | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | yes | 4 | 0 | 0 | 0.6 |
| d344e2aa | serieswatch | v1 | baseline | pass | seeded: classification truth (4/4 services agree) | yes | 10 | 0 | 0 | 0.9 |
| e86ed54b | serieswatch | v2 | baseline | pass | seeded: classification truth (4/4 services agree) | yes | 10 | 0 | 0 | 1.2 |
| 3ab7a0e8 | serieswatch | v3 | baseline | inconclusive | seeded: classification truth (4/4 services agree) | yes | 10 | 0 | 0 | 1.6 |
| 80ea9bd2 | filterproof | 1.20.1-corpus-v1 | baseline | fail | policy run (documented behaviors) | n/a | 5 | 0 | 0 | 2.1 |
| 80251812 | dashboardreplay | r2-valid | baseline | pass | clean candidate | yes | 5 | 0 | 0 | 2.1 |
| ce649b3a | dashboardreplay | r3-scope | baseline | fail | seeded: scope_matches_reference | yes | 5 | 0 | 0 | 2.1 |
| d1efc27a | dashboardreplay | r4-unit | baseline | fail | seeded: unit_declared | yes | 5 | 0 | 0 | 2.1 |
| b087aea6 | dashboardreplay | r5-unsupported | baseline | unsupported | seeded: unsupported revision | yes | 5 | 0 | 0 | 2.1 |
| 08cc1029 | routereplay | v1-reviewed | baseline | pass | clean candidate | yes | 4 | 0 | 0 | 4.3 |
| 4df1c1e7 | routereplay | v2-candidate | baseline | fail | seeded: routed_to_intended_receiver | yes | 4 | 0 | 0 | 6.5 |
| 4ed089f0 | routereplay | v3-candidate | baseline | fail | seeded: grouped_by_team | no | 4 | 0 | 0 | 8.5 |
| a48d4461 | metriccontract | v5 | agent | inconclusive | seeded: unit_witnessed | no | 2 | 0 | 2147 | 0.3 |
| e9d0c429 | serieswatch | v2 | agent | inconclusive | seeded: classification truth (0/4 services agree) | no | 1 | 13 | 16202 | 1.6 |
| 0f3384f8 | dashboardreplay | r3-scope | agent | inconclusive | seeded: scope_matches_reference | no | 4 | 0 | 4287 | 1.8 |
| 50a415f9 | filterproof | 1.20.1-corpus-v1 | agent | fail | policy run (documented behaviors) | n/a | 6 | 0 | 14304 | 2.8 |
| 46a3bccc | routereplay | v3-candidate | agent | fail | seeded: grouped_by_team | yes | 10 | 0 | 10156 | 5.2 |
| ac63221c | alertscenario | v2-candidate | baseline | pass | seeded: missing_data_not_reported_as_recovery | no | 4 | 0 | 0 | 11.7 |
| 116aa6c5 | alertscenario | v3-candidate | baseline | fail | seeded: short_spike_does_not_fire | yes | 4 | 0 | 0 | 17.2 |
| 3ce7608e | alertscenario | v4-candidate | agent | inconclusive | seeded: short_spike_does_not_fire | no | 2 | 3 | 5496 | 18.2 |
| 475f4ec6 | metriccontract | v5 | agent | inconclusive | seeded: unit_witnessed | no | 2 | 3 | 5143 | 0.3 |
| 70b9e7f6 | serieswatch | v2 | agent | inconclusive | seeded: classification truth (0/4 services agree) | no | 14 | 0 | 14200 | 1 |
| e9830cb2 | dashboardreplay | r3-scope | agent | inconclusive | seeded: scope_matches_reference | no | 10 | 0 | 10288 | 1.3 |
| d2ce9c26 | alertscenario | v2-candidate | baseline | fail | seeded: missing_data_not_reported_as_recovery | yes | 4 | 0 | 0 | 7.7 |
| eef96374 | routereplay | v1-reviewed | baseline | pass | clean candidate | yes | 4 | 0 | 0 | 10.6 |
| a32886ce | routereplay | v2-candidate | baseline | fail | seeded: routed_to_intended_receiver | yes | 4 | 0 | 0 | 13.8 |
| 96bda935 | routereplay | v3-candidate | baseline | fail | seeded: grouped_by_team | yes | 4 | 0 | 0 | 17.3 |
| 7e9b8586 | alertscenario | v4-candidate | agent | fail | seeded: short_spike_does_not_fire | no | 5 | 5 | 12943 | 23.4 |
| 51dab887 | metriccontract | v5 | agent | inconclusive | seeded: unit_witnessed | no | 1 | 3 | 4597 | 22.4 |
| 3fd0a0a8 | filterproof | 1.20.1-corpus-v1 | agent | fail | policy run (documented behaviors) | n/a | 3 | 4 | 16453 | 23 |
| cff58da6 | serieswatch | v2 | agent | inconclusive | seeded: classification truth (0/4 services agree) | no | 1 | 3 | 4656 | 21.5 |
| 189ae69a | dashboardreplay | r3-scope | agent | inconclusive | seeded: scope_matches_reference | no | 0 | 0 | 11390 | 21.8 |
| 66bcd613 | alertscenario | v4-candidate | agent | failed | seeded: short_spike_does_not_fire | no | 3 | 0 | 0 | 25.8 |
| 27de2328 | routereplay | v2-candidate | agent | failed | seeded: routed_to_intended_receiver | no | 0 | 0 | 0 | 25.8 |
| 39abf896 | serieswatch | v1 | baseline | pass | seeded: classification truth (4/4 services agree) | yes | 10 | 0 | 0 | 0.3 |
| eac7169d | alertscenario | v1-reviewed | baseline | pass | clean candidate | yes | 4 | 0 | 0 | 6.8 |
| 330e402c | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | yes | 4 | 0 | 0 | 0.1 |
| 5aac7dba | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | yes | 4 | 0 | 0 | 0.1 |
| d5692cfd | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | yes | 4 | 0 | 0 | 0.1 |
| fae01874 | metriccontract | v5 | baseline | fail | seeded: unit_witnessed | yes | 4 | 0 | 0 | 0.1 |
