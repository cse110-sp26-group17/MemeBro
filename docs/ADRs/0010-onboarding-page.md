## First-Visit Onboarding Page
### Context

The title/onboarding page currently appears every time the app is opened. This adds friction for returning users because they have already seen the introduction and want to start from the template gallery.

The app also needs to avoid sending returning users to a blank templates screen. When onboarding is skipped, the Trending tab should load normally and display templates immediately.

### Decision

Add a persistent `firstVisit` flag for onboarding state.

The flag starts as `false`. When the app opens, it checks the persisted `firstVisit` value:

- If `firstVisit` is `false`, show the title page.
- When the user clicks "Get started", set `firstVisit` to `true` and persist it in localStorage.
- If `firstVisit` is `true`, skip the title page and open the Trending tab.

The returning-user path must load the template catalog and render the Trending tab so the user sees available meme templates instead of an empty grid.

If localStorage is cleared, the persisted flag is removed and the app treats the next visit as a first visit again.

### Consequence

New users still see the onboarding/title page before entering the app. Returning users go directly to the Trending tab and can start from the meme template grid without clicking through onboarding again.

The onboarding state persists across reloads and browser sessions as long as localStorage remains available.

### Trade-Offs/Risks

The flag depends on localStorage. If browser storage is unavailable, blocked, or cleared, the app falls back to showing onboarding again.

This decision prioritizes a predictable template-gallery start for returning users over automatically restoring previous editor work on app load. Saved and recent memes remain accessible through their existing flows.
