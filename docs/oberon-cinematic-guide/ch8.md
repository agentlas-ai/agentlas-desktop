📌
3줄 요약
1. 화면비는 장식이 아니라 시대·장르를 알리는 신호입니다 — 넣고 좋은 것이 아니라 의도를 가지고 고르세요.
2. 딥포커스는 관객이 시선을 고르게 하고, 얕은 포커스(shallow focus)는 감독이 시선을 강제합니다 — 둘 중 하나를 의도적으로 고르세요.
3. 보케의 모양과 네거티브 스페이스도 프롬프트로 지시할 수 있는 시각 요소입니다.
앞서 샷 사이즈와 앵글, 조명을 배웠습니다. 이번 챕터는 그보다 한 단계 깊은 이야기입니다 — 렌즈가 실제로 화면을 어떻게 조작하는지, 그리고 그 조작 자체가 어떻게 관객의 시선과 감정을 조종하는지입니다. AI 이미지 모델은 실제 카메라가 아니지만, 이 용어들을 이미 사진·영화 데이터에서 학습했기 때문에 그대로 써도 효과가 있습니다.
화면비(Aspect Ratio)는 장식이 아니라 신호다
같은 장면도 화면의 가로세로 비율이 바뀌면 관객이 무의식적으로 받아들이는 장르와 시대감이 달라집니다. 화면비는 단순한 프레이밍 그릇이 아니라, 관객이 학습해온 영화적 관습의 신호입니다.
화면비
	
인상
	
적합한 장면


2.39:1 (시네마스코프)
	
웅장함, 서사시, 영화적 그 자체
	
서사시·액션·SF 대서사, 장대한 풍경


1.85:1 (표준 와이드)
	
현대적, 중립적, 자연스러운 극영화 느낌
	
대부분의 현대 극영화, 드라마


4:3 / 1.33:1
	
복고적이거나 낡은 시대감, 좁거나 폐쇄적인 느낌
	
회상 장면, 공포·폐쇄공포증, 시대극(TV 시대)


1:1 (정사각)
	
친밀하고 정적인, SNS적, 양자를 직접 대면하는 느낌
	
인물 초상, 정면 응시 컷


2.76:1 (초광각 와이드)
	
극단적으로 광활한 스케일, 서사시 장르의 극치
	
사막·우주·광활한 전투 장면
같은 장면을 두 화면비로 생성해보면 차이가 명확해집니다.
다른 모든 요소는 동일하게, 화면비만 2.39:1 시네마스코프와 4:3 클래식 스타일로 각각 생성. 동일한 인물, 동일한 조명, 동일한 구도.
프롬프트에 화면비를 명시할 때는 "2.39:1 anamorphic widescreen aspect ratio" 또는 "4:3 vintage television aspect ratio"처럼 비율과 시대감을 함께 적으면 AI가 더 정확히 반응합니다.
심도(Depth of Field)의 두 극단: 딥포커스 vs 얕은 포커스
심도는 관객이 화면에서 어디를 보게 만드는가의 문제입니다. 두 극단이 있고, 이 둘은 관객에게 정반대되는 경험을 줍니다.
딥포커스(Deep Focus) — 전경부터 후경까지 모두 선명하게 보입니다. 관객이 스스로 시선을 고르게 되어 "민주적인 프레임"이라고도 불립니다. 여러 인물이 서로 다른 거리에서 동시에 행동할 때, 모든 관계를 동시에 보여줘야 할 때 쓰입니다.
deep focus composition, foreground, midground, and background all in sharp focus, wide angle lens, everything visible and legible
얕은 포커스(Shallow Focus) — 피사체만 선명하고 나머지는 흐릿합니다. 감독이 관객의 시선을 강제로 통제합니다. 감정적으로 친밀하거나 고립된 순간에 쓰입니다.
shallow depth of field, subject in sharp focus, background completely blurred into soft bokeh, 85mm lens at f/1.4
랙 포커스(Rack Focus) — 정지 이미지로는 직접 표현할 수 없지만, 멀티 패널이나 이미지 스택으로 "초점 이동"을 암시할 수 있습니다. 한 패널은 전경에 초점, 다음 패널은 배경에 초점을 맞춰 생성하면 I2V 단계에서 포커스 전환을 지시할 때 기준이 됩니다.
스플릿 디옵터(Split Diopter) — 드물게 쓰이는 기법입니다. 화면의 절반은 가깝고 절반은 멀지만, 둘 다 선명하게 보입니다. 긴장감이나 기이한 이질감을 줄 때 쓰입니다(브라이언 데 팔마가 즐겨 쓴 기법).
split diopter effect, extreme close-up in the foreground and a figure in the background both in perfect focus simultaneously, unnatural dual-focus composition
보케(Bokeh)의 모양도 스타일입니다
배경 빛 번짐의 모양은 렌즈의 종류에 따라 달라지고, 이 차이를 프롬프트에 명시하면 더 구체적인 질감을 얻을 수 있습니다.
보케 형태
	
느낌


round bokeh (원형)
	
부드럽고 균일한, 현대적인 느낌


oval anamorphic bokeh (타원형)
	
영화적이고 빈티지한 느낌, 가로로 길게 퍼지는 렌즈 플레어와 함께 오는 경우가 많음


cat-eye bokeh (고양이눈 형)
	
화면 가장자리로 갈수록 날카로워지는 보케, 빈티지 렌즈의 대표적 특징
네거티브 스페이스와 시각적 무게
프레임 안의 빈 공간(네거티브 스페이스)은 장식이 아니라 시선을 담아두는 그릇입니다. 인물이 프레임의 한쪽에만 있고 나머지가 비어있으면, 관객의 시선은 그 빈 공간으로 자연스럽게 향합니다 — 마치 인물이 바라보는 방향을 관객도 같이 궁금해하는 것처럼요. 이를 "시선 방향으로 여백을 놓는다"는 원칙으로 기억하세요.
subject positioned on the left third of the frame, looking toward the right, negative space filling the right two-thirds, creating anticipation and visual tension
여백이 인물의 시선 반대편에 있으면 답답하고 고립된 느낌을, 시선 방향에 있으면(리드룸, leadroom) 기대와 호기심을 전달합니다.
예시 프롬프트 모음
위에서 다루어 온 개념을 직접 생성해볼 수 있는 프롬프트로 정리했습니다.
화면비 비교 (2.39:1 vs 4:3)
A detective sitting alone in an empty interrogation room, one fluorescent light hanging directly overhead and dropping a single vertical beam onto the table. The same character, same lighting, and same composition rendered in two aspect ratios for comparison: a 2.39:1 anamorphic widescreen cinemascope framing, and a 4:3 vintage broadcast television framing. Neutral cinematic tone, sharp focus, stark overhead lighting.
🇰🇷 핵심: 동일 인물·조명·구도를 2.39:1과 4:3으로 각각 생성해 비교
딥포커스
Three people standing at three different distances inside a living room: the nearest figure with their back to the camera, a middle figure caught mid-conversation, and the farthest figure standing quietly by a window. Shot on a wide angle lens with deep focus composition, keeping the foreground, midground, and background all equally sharp and legible at once. Natural daylight streaming through the window, clean neutral color tones, a democratic frame where every relationship is visible simultaneously.
🇰🇷 핵심: 서로 다른 거리의 세 인물이 모두 선명한 딥포커스, 광각 렌즈
얕은 포커스(Shallow Focus)
A woman's face in close-up inside a busy café, her expression sharp and clear while everything behind her — other patrons, hanging lights, the café interior — dissolves into soft, creamy bokeh. Shot on an 85mm lens at f/1.4, extremely shallow depth of field isolating only her face in focus. Gentle warm ambient tones, intimate and controlled attention drawn entirely to her.
🇰🇷 핵심: 카페 클로즈업, 배경은 완전히 흐린 보케, 85mm f/1.4 얕은 심도
랙 포커스(2단계, I2V 브릿징용)
A folded letter resting on a table in the foreground, with a figure standing quietly in the background of the same room. Rendered in two paired images for a focus-pull transition: stage one has sharp focus on the letter with the background figure softly blurred, stage two racks focus onto the background figure with the foreground letter now blurred. Identical composition and lighting across both stages, natural indoor light, neutral color tones, designed as start and end frames for a focus transition.
🇰🇷 핵심: 전경 편지→배경 인물로 초점 이동하는 2단계 이미지, I2V 시작·끝 프레임용
스플릿 디옵터
A hand gripping a doorknob in extreme close-up in the very foreground of a narrow hallway, while a figure walks slowly toward the camera from the far end of the same corridor in the background. Split diopter effect rendering both the extreme foreground and the distant background in perfect, simultaneous sharp focus, an unnatural dual-focus composition that shouldn't be optically possible. Neutral color tones, quiet tension building between the two focal points.
🇰🇷 핵심: 전경 문손잡이와 배경 인물이 동시에 선명한 스플릿 디옵터
보케 — 원형(Round)
A person walking alone down a city street at night, rows of streetlights glowing softly behind them. The background lights dissolve into smooth, perfectly round bokeh circles, evenly shaped and gently blurred. Clean modern digital lens character, calm nighttime atmosphere, soft ambient glow.
🇰🇷 핵심: 밤거리 배경이 부드럽고 균일한 원형 보케로 번짐, 현대적 디지털 렌즈
보케 — 아나모르픽 오벌(Oval Anamorphic)
The same person walking down the same city street at night, but this time the background streetlights stretch into elongated horizontal oval bokeh shapes, accompanied by faint horizontal lens flare streaks drifting across the frame. Classic vintage anamorphic cinema lens character, cinematic widescreen feel, warm nighttime glow.
🇰🇷 핵심: 배경 조명이 가로로 늘어난 타원형 보케, 렌즈 플레어 동반의 빈티지 아나모르픽 느낌
보케 — 캣츠아이(Cat-eye)
The same nighttime street scene once more, this time with the background bokeh narrowing into distinctive cat-eye shapes as it approaches the edges of the frame, wider and rounder near the center. Characteristic vintage anamorphic lens edge distortion, subtle mechanical vignetting, nostalgic cinematic texture.
🇰🇷 핵심: 화면 가장자리로 갈수록 좁아지는 캣츠아이 보케, 빈티지 아나모르픽 가장자리 왜곡
네거티브 스페이스
A figure standing within the left third of the frame, gazing toward the right, where the remaining two-thirds of the frame opens into an empty stretch of sky or plain wall. Wide shot composition with generous negative space deliberately placed in the direction of the figure's gaze, creating a quiet sense of anticipation and visual tension. Minimal, restrained color palette, calm stillness.
🇰🇷 핵심: 인물 시선 방향으로 여백을 크게 남긴 구도, 기대감을 만드는 네거티브 스페이스
체크리스트
□ 화면비: 이 장면의 장르·시대감에 맞는 비율인가?
□ 심도: 관객이 스스로 볼지(딥포커스) 강제로 볼지(얕은 포커스) 결정했는가?
□ 보케: 배경 빛 번짐의 모양을 지정했는가?
□ 여백: 인물이 보는 방향으로 공간이 넣어져 있는가?
목차로 돌아가기