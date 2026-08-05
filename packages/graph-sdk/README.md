# @agentlas/graph-sdk

코드에서 Agentlas 자동화(그래프)를 켜는 입구입니다.

```js
import { openGraphSurface } from "@agentlas/graph-sdk";

const surface = openGraphSurface({ binary: "/Applications/Agentlas.app/Contents/MacOS/Agentlas" });
console.log(await surface.listGraphs());
console.log(await surface.runGraph("아침 요약", { topic: "환율" }));
await surface.close();
```

## 무엇을 돌려주나

`runGraph`는 **접수 여부**를 돌려줍니다. 실행 자체는 Agentlas가 합니다.

- 접수됨 — `{ ok: true, automationId, automationName, eventId, input }`
- 켤 수 없음 — `{ ok: false, code, reason, nextAction }`

거절은 예외로 던지지 않습니다. 사유가 스택 안에서 뭉개지면 부른 코드가 무엇을 고쳐야
하는지 알 수 없기 때문입니다. 예외는 표면 자체에 닿지 못했을 때만 납니다.

거절 코드: `RUN_REQUEST_REF_MISSING` · `RUN_REQUEST_REF_AMBIGUOUS` · `RUN_REQUEST_NOT_FOUND`
· `RUN_REQUEST_DISABLED` · `RUN_REQUEST_INPUT_REQUIRED` · `RUN_REQUEST_QUEUE_UNAVAILABLE`

## 전송

stdio뿐입니다. Agentlas 실행 파일을 `--graph-surface`로 띄워 줄 단위 JSON을 주고받습니다.
포트를 열지 않으므로 네트워크에서 도달할 방법이 없습니다.

## 배포 상태

아직 npm에 올리지 않았습니다(`private: true`). 지금은 저장소 안에서 경로로 불러 씁니다.
