# Claude-Cron 개선 계획서

## 분석 완료일: 2026-02-03

---

## 1. 핵심 문제점 요약

| 영역 | 문제 | 영향도 |
|------|------|--------|
| 시스템 프롬프트 | 9줄의 단순 프롬프트, 행동 지침 부재 | HIGH |
| 메모리 시스템 | 읽기 없이 쓰기만 지시, 검색 불가 | HIGH |
| 자동화 | 모두 수동 트리거, proactive 행동 없음 | HIGH |
| 아키텍처 | 상태 없는 메시지 중계기 구조 | MEDIUM |

---

## 2. 즉시 적용 가능한 개선 (Phase 1)

### 2.1 시스템 프롬프트 교체
- 파일: `memory/system-prompt.md` → `memory/system-prompt-v2.md` 내용으로 교체
- 효과: 메모리 활용, 자동 기록, 맥락 연결 지침 추가

### 2.2 템플릿 파일 활성화
- 위치: `memory/templates/` 생성 완료
- 적용: `telegram-bot.ts:159-174`의 `initUserMemory()` 수정 필요

### 2.3 메모리 프롬프트 개선
- 위치: `telegram-bot.ts:271-272`
- 변경: "쓰기만" → "읽기 후 쓰기" 로직으로 변경

---

## 3. 중기 개발 필요 (Phase 2, 2-3주)

### 3.1 구조화된 데이터 저장
```
memory/{chatId}/
├── structured/
│   ├── todos.json        # 할일 목록
│   ├── appointments.json # 약속/일정
│   └── mood-log.jsonl    # 감정 기록
```

### 3.2 주간 리뷰 태스크
```yaml
# tasks/_schedule.yaml
- id: weekly-review
  file: weekly-review.md
  cron: "0 21 * * 0"  # 매주 일요일 21시
  notify: [telegram]
```

### 3.3 일일 마무리 질문
```json
// config/reminders.json에 추가
{
  "id": "daily-reflection",
  "chatId": 6285274703,
  "type": "task",
  "message": "오늘 하루 어떠셨어요? 기록해둘 것 있으면 말씀해주세요.",
  "hour": 22,
  "minute": 0,
  "cron": "0 22 * * *"
}
```

---

## 4. 장기 개발 (Phase 3, 4-8주)

### 4.1 새 컴포넌트
| 컴포넌트 | 목적 | 예상 노력 |
|----------|------|-----------|
| `memory-manager.ts` | 구조화된 메모리 저장/검색 | 3-5일 |
| `context-compiler.ts` | 대화 시작시 관련 맥락 자동 주입 | 2-3일 |
| `insight-engine.ts` | 패턴 분석, 사용자 선호 학습 | 5-7일 |
| `proactive-scheduler.ts` | 봇이 먼저 말걸기 트리거 | 3-5일 |

### 4.2 제안 아키텍처
```
INPUT LAYER (telegram-bot, scheduler)
       ↓
CONTEXT LAYER (context-compiler ↔ memory-manager)  [NEW]
       ↓
EXECUTION LAYER (executor, reminders)
       ↓
LEARNING LAYER (insight-engine → self-improver)   [NEW]
       ↓
OUTPUT LAYER (notifier)
```

---

## 5. 생성된 파일 목록

- `memory/system-prompt-v2.md` - 개선된 시스템 프롬프트
- `memory/templates/USER.md` - 사용자 정보 템플릿
- `memory/templates/MEMORY.md` - 중요 기억 템플릿
- `memory/templates/IDENTITY.md` - 봇 정체성 템플릿
- `memory/templates/areas/work.md` - 업무 영역 템플릿
- `memory/templates/areas/health.md` - 건강 영역 템플릿

---

## 6. 다음 단계 권장사항

1. **즉시**: `system-prompt.md`를 `system-prompt-v2.md` 내용으로 교체
2. **1주 내**: 템플릿 복사 로직 활성화 (`telegram-bot.ts` 수정)
3. **2주 내**: 일일 마무리 질문 리마인더 추가
4. **1개월**: 주간 리뷰 태스크 구현
5. **2개월**: Memory Manager + Context Compiler 개발

---

## 참고 자료

- 시스템 프롬프트 분석: Worker 1 (Analyst)
- 메모리 시스템 분석: Worker 2 (Architect)
- 자동화 메커니즘 분석: Worker 3 (Architect)
- 아키텍처 분석: Worker 4 (Architect)
