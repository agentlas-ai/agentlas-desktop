📌
3줄 요약
1. 구조화는 AI에게 맡기는 임의 결정의 범위를 줄이는 일입니다.
2. 처음에는 6하원칙(누가·언제·어디서·어떻게·무엇을·왜)으로 시작하세요.
3. 샷이 많아지면 JSON/YAML/XML 같은 구조화 형식으로 관리하면 특정 항목만 고치기 쉽습니다.
프롬프트 구조화가 필요한 이유
앞에서 봤듯이 시네마틱한 이미지를 생성하기 위해서는 아주 많은 정보가 입력되어야 합니다, 한 장의 이미지를 온전히 내가 원하는대로 조정하기 위해서는 내가 원하는 것을 명확하게 정돈할 필요가 있습니다.
"어두운 방에서 슬퍼하는 여자"라고 프롬프트를 쓰면 이미지가 나옵니다. 하지만 그 이미지가 영화의 한 컷처럼 보일 가능성은 낮습니다. AI는 "어두운 방"을 어떻게 해석할지, "슬퍼하는"을 어떤 표정으로 표현할지, 카메라가 어디에 있는지를 전부 임의로 결정합니다.
프롬프트를 구조화한다는 것은, AI에게 맡기는 임의 결정의 범위를 줄이는 것입니다. "어두운 방에서 슬퍼하는 여자" 대신, 무엇을(피사체), 어디서(장소), 어떻게(프레이밍, 조명), 왜(감정, 분위기)를 명시적으로 분리하여 전달하면, AI의 임의 해석이 줄어들고 원하는 결과에 가까운 이미지가 나옵니다.
구조화의 방법은 여러 가지가 있습니다. 가장 직관적인 방법부터 살펴보겠습니다.
1. 6하원칙으로 프롬프트 구조 잡기
프롬프트 구조화가 처음이라면, 뉴스 기사의 6하원칙(5W1H)을 응용하는 것이 가장 쉬운 출발점입니다.
영화 한 컷을 만들 때 답해야 하는 질문을 여섯 가지로 나눕니다.
질문
	
영화 촬영 요소
	
프롬프트에서의 역할


누가 (Who)
	
피사체
	
어떤 인물이 화면에 있는가


언제 (When)
	
시간대
	
낮인가 밤인가, 어떤 빛인가


어디서 (Where)
	
장소 / 배경
	
어떤 공간에서 일어나는가


어떻게 (How)
	
카메라 / 조명
	
어떤 프레이밍과 조명으로 잡는가


무엇을 (What)
	
행동 / 상태
	
인물이 무엇을 하고 있는가


왜 (Why)
	
감정 / 분위기
	
이 컷이 전달하는 느낌은 무엇인가
6하원칙 프롬프트 예시
질문에 하나씩 답하면 프롬프트가 됩니다.
장면: 연구소에서 무언가를 발견한 여성 과학자
누가: 30대 한국인 여성, 흰색 연구복, 짧은 단발
어디서: 어두운 연구소 내부, 모니터들이 늘어선 공간
무엇을: 모니터를 응시하며 눈을 크게 뜨고 있다
어떻게: 클로즈업, 정면 약간 측면, 모니터에서 나오는 빛이 얼굴 한쪽을 비춤
언제: 밤, 실내 인공 조명만 존재
왜: 발견의 순간, 긴장과 경이가 공존하는 분위기
6하원칙의 각 답변이 합쳐져 하나의 프롬프트로 구성이 되었습니다. 이 방식의 장점은 빠뜨리는 정보 없이 체계적으로 프롬프트를 구성할 수 있다는 점입니다. 한글로 작성한 요소들을 그대로 입력해도 좋고, 이 프롬프트를 그대로 영어 프롬프트로 변환하여 입력하는 것도 추천합니다.
2. 구조화된 데이터 형식으로 프롬프트 관리하기
6하원칙으로 시작한 후, 프롬프트를 더 체계적으로 관리하고 싶어지면 구조화된 데이터 형식을 활용할 수 있습니다. 대표적으로 JSON, YAML, XML 세 가지가 있습니다. 이것들은 프로그래밍 언어가 아니라, 정보를 정리하는 형식입니다. 마치 서류의 양식이 다양하듯, 같은 정보를 다른 형태로 적는 방법이라고 생각하면 됩니다.
아래의 예시를 참조하여 6하원칙으로 먼저 작성한 이후 각자 사용하시는 LLM (ChatGPT, Gemini, Claude 등)을 이용하여 그대로 치환하시는 것이 처음에는 가장 접근하기 좋습니다.
JSON — 가장 널리 쓰이는 형식
중괄호 { } 안에 "항목 이름": "값" 쌍으로 정보를 적습니다.
json
{
  "who": "Korean woman, 30s, short bob hair, white lab coat",
  "where": "Dark laboratory with rows of monitors",
  "what": "Staring at monitor with wide eyes",
  "camera": "Close-up, slightly angled, shallow depth of field",
  "lighting": "Monitor's cold blue light on one side of face, Rembrandt style",
  "when": "Night, artificial light only",
  "mood": "Tense discovery, cinematic, photorealistic, film grain"
}
JSON의 장점 : 항목이 명확하게 분리되어 있어서, 특정 항목만 수정하기 쉽습니다. "조명만 바꾸고 싶다"면 lighting 값만 수정하면 됩니다.
YAML — 가장 읽기 편한 형식
들여쓰기로 구조를 나타냅니다. 중괄호가 없어서 눈에 편합니다.
yaml
who: Korean woman, 30s, short bob hair, white lab coat
where: Dark laboratory with rows of monitors
what: Staring at monitor with wide eyes
camera: Close-up, slightly angled, shallow depth of field
lighting: Monitor's cold blue light on one side of face, Rembrandt style
when: Night, artificial light only
mood: Tense discovery, cinematic, photorealistic, film grain
YAML의 장점 : 가장 직관적이고 읽기 쉽습니다. 메모장에 적는 것처럼 자연스럽습니다.
XML — 태그로 감싸는 형식
꺾쇠 괄호 < > 안에 태그 이름을 넣고, 그 사이에 내용을 적습니다.
xml
<shot>
  <who>Korean woman, 30s, short bob hair, white lab coat</who>
  <where>Dark laboratory with rows of monitors</where>
  <what>Staring at monitor with wide eyes</what>
  <camera>Close-up, slightly angled, shallow depth of field</camera>
  <lighting>Monitor's cold blue light on one side of face, Rembrandt style</lighting>
  <when>Night, artificial light only</when>
  <mood>Tense discovery, cinematic, photorealistic, film grain</mood>
</shot>
XML의 장점 : 여는 태그와 닫는 태그가 있어서 구조가 명확합니다.
어떤 형식을 쓰면 좋은가
세 가지 형식 중 자신에게 편한 것을 고르면 됩니다. 실제로 Nano Banana 2에 입력할 때에는 단일 방식을 사용하거나 자연어와 구조화 프롬프트를 혼용하기도 합니다, 복잡한 내용은 구조화 하고 간단한 내용은 자연어로 그대로 써도 됩니다.
하나의 장면에 여러 샷이 있을 때, 구조화된 형식의 진짜 가치가 드러납니다. 샷마다 정보를 같은 양식으로 정리해두면, 어떤 샷에서 무엇이 바뀌는지가 한눈에 보입니다.
자주 하는 실수와 해결법
실수 1: 프롬프트에 감정만 쓰고 시각 정보를 빠뜨린다
"슬프고 외로운 분위기"라고만 쓰면 AI는 그것을 어떻게 시각화할지 모릅니다. 감정은 조명, 색감, 프레이밍으로 번역해야 합니다. "슬프다"는 "low-key lighting, desaturated cool tones, character small in frame, wide shot"이 됩니다.
실수 2: 한 프롬프트에 너무 많은 것을 넣는다
"두 사람이 카페에서 대화하다가 한 명이 일어나서 나가고, 남은 사람이 커피를 마시며 창밖을 본다"는 하나의 이미지로 표현할 수 없습니다. 이것은 3~4개의 샷입니다. 하나의 프롬프트에는 하나의 순간만 담습니다.
실수 3: 영어 키워드를 무작정 나열한다
"cinematic, 8K, ultra HD, masterpiece, best quality, extremely detailed, professional photography, award winning" — 이런 키워드 나열은 Nano Banana 2에서 거의 효과가 없습니다. 구체적인 시각 정보(샷 사이즈, 조명 방향, 렌즈 느낌)가 추상적 품질 키워드보다 훨씬 효과적입니다. "cinematic, photorealistic, film grain" 정도면 충분합니다.
실수 4: 레퍼런스 이미지 없이 캐릭터 일관성을 기대한다
같은 캐릭터를 여러 샷에서 만들 때, 텍스트 묘사만으로는 얼굴이 매번 달라집니다. 캐릭터 레퍼런스 가이드에서 만든 캐릭터 시트를 반드시 함께 업로드해야 일관성이 유지됩니다.
목차로 돌아가기