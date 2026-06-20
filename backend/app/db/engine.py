from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()

# Pool sized for the parallel run pipeline: several combinations run concurrently,
# each holding its own session, plus progress/aggregation sessions on top.
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=10,
)

async_session = async_sessionmaker(engine, expire_on_commit=False)
