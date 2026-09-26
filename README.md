# Schema Evolution Studio

Local workbench for managing migration functions between schema revisions and
comparing migration paths between any two revisions on fixed samples.

## Model

- **Revisions** are nodes with an ordered version number and a field schema.
- **Migrations** are directed edges with a numeric **cost**, a declarative
  **applicability condition** (`always` / `fieldExists` / `fieldEquals`), a
  **reversible** marker, declared input/output schemas, and a versioned
  JavaScript function body (the body of `(doc) => {...}`).
- Back edges (toward older revisions) are allowed and create cycles; cycles are
  detected and surfaced. A back edge is only usable for rollback planning when
  its forward migration is marked `reversible`.

## Paths

`GET /api/paths?from=v1&to=v4&rollback=false` enumerates simple paths and sorts
them by **total cost**，从不按边数假定最佳——最便宜的路径可以比直连条件边有更多跳。
无效路径仍会返回，并附带精确问题码（`input_incompatible`、`output_incompatible`、
`chain_incompatible`、`rollback_not_reversible`、`bad_condition`、
`bad_function`）。组合在执行前校验：每条边对照端点 schema 检查，且前一条边的
输出必须满足下一条边的输入。

## Experiments

`POST /api/experiments` 在同一个固定样例上运行所选路径。

- 计划绑定**图修订号**：并发编辑会使启动请求返回 `409 revision_conflict`，
  强制重新规划。
- 执行开始时，每条边（连同其**函数修订号**）被快照绑定；实验运行期间修改函数
  不会改变该实验的结果。
- 每一步记录精确的边、绑定的函数修订、输入与输出。条件或函数失败会把该路径置为
  `failed`，同时保留此前所有中间文档；同一样例上的等价路径仍独立完成。
- `POST /api/experiments/:id/cancel` 可中断执行：进行中与排队的路径变为
  `cancelled`，已完成的路径结果不受影响。

图编辑（`PUT/POST/DELETE /api/edges`）使用乐观并发控制：请求需携带当前图
`revision`，陈旧写入返回 `409`。

## 开发

```bash
npm install
npm run dev      # api 在 :4174，vite 在 :4173
npm test         # vitest：图核心逻辑 + 服务场景
npm run build    # tsc + vite build
```

测试覆盖：多条等价路径、条件不满足、运行中更新函数、回滚路径、部分失败保留
中间结果、并发编辑冲突与取消执行。
