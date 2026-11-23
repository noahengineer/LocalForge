---
type: llm
focus: trace
weight: 1
---

Handles audio correctly for a machine without a sound device (SDL_AUDIODRIVER=dummy, or mixer failures cannot crash the game) and does not claim that pygame.init() itself crashes without one
