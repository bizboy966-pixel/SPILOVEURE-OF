"""Shared pytest configuration for the backend test-suite.

Python 3.11 removed the implicit main-thread event loop and pytest-asyncio
unsets/closes the current loop after each async test.  Several legacy test
modules use a synchronous `_run(...)` helper together with a module-scoped
Motor client, which resolves `asyncio.get_event_loop()` eagerly.  When such a
module runs *after* an async (pytest-asyncio) module, `get_event_loop()` raises
`RuntimeError: There is no current event loop`.

To keep the suite runnable as a whole (and mirror the pre-3.10 behaviour) we
install a tolerant event-loop policy that lazily (re)creates a loop instead of
raising.  This only affects the test process, never application code.
"""
import asyncio


class _TolerantEventLoopPolicy(asyncio.DefaultEventLoopPolicy):
    def get_event_loop(self):
        try:
            loop = super().get_event_loop()
        except RuntimeError:
            loop = None
        if loop is None or loop.is_closed():
            loop = self.new_event_loop()
            self.set_event_loop(loop)
        return loop


asyncio.set_event_loop_policy(_TolerantEventLoopPolicy())
