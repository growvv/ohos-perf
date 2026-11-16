-- Synthetic trace for the ArkUI component-reuse parity fixture.
--
-- HapRay's `ComponentReusableAnalyzer` queries `callstack` only, so this is the
-- whole schema it needs. The seven rows were run through HapRay 9386e4e to
-- produce `components.components.json`; do not edit either file without
-- regenerating the golden (see `scripts/parity/README.md`).
--
-- Expected HapRay payload:
--   {"details": {"ItemView": [4, 2], "Text": [3, 0]},
--    "max_component": "ItemView", "recycled_builds": 2,
--    "reusability_ratio": 0.5, "total_builds": 4}
--
-- Note `total_builds` is the MAX component's build count (4), not the sum over
-- components (7). That is HapRay's shape, preserved on purpose.
CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
  depth INT, cookie INT, parent_id INT, argsetid INT, chainId TEXT, spanId TEXT,
  parentSpanId TEXT, flag TEXT, trace_level TEXT, trace_tag TEXT,
  custom_category TEXT, custom_args TEXT, child_callid INT);

INSERT INTO callstack VALUES
 (0, 1000, 10, 44, 'App', 'H:CustomNode:BuildItem [ItemView][self:86][parent:-1]', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (1, 1001, 10, 44, 'App', 'H:CustomNode:BuildRecycle ItemView', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (2, 1002, 10, 44, 'App', 'H:CustomNode:BuildItem [ItemView][self:87][parent:-1]', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (3, 1003, 10, 44, 'App', 'H:CustomNode:BuildRecycle ItemView', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (4, 1004, 10, 44, 'App', 'H:CustomNode:BuildItem [Text][self:88][parent:-1]', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (5, 1005, 10, 44, 'App', 'H:CustomNode:BuildItem [Text][self:89][parent:-1]', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
 (6, 1006, 10, 44, 'App', 'H:CustomNode:BuildItem [Text][self:90][parent:-1]', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0);
