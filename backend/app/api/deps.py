from fastapi import Request

from app.db.session import get_session  # noqa: F401 (re-exported as a dependency)


async def get_arq(request: Request):
    """The shared arq pool, created in the app lifespan."""
    return request.app.state.arq
