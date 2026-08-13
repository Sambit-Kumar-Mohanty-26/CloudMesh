"""Official Python SDK for the CloudMesh AI gateway.

    from cloudmesh import CloudMesh

    cm = CloudMesh(api_key="cm_live_...")
    response = cm.chat.create(model="auto", messages=[{"role": "user", "content": "Hi"}])
    print(response.content)
"""

from .client import ChatChunk, ChatResponse, CloudMesh, Usage
from .errors import (
    AuthenticationError,
    BudgetExceededError,
    CloudMeshConnectionError,
    CloudMeshError,
    InvalidRequestError,
    NotFoundError,
    RateLimitError,
    ServiceError,
)

__version__ = "0.1.0"

__all__ = [
    "CloudMesh",
    "ChatResponse",
    "ChatChunk",
    "Usage",
    "CloudMeshError",
    "AuthenticationError",
    "InvalidRequestError",
    "BudgetExceededError",
    "NotFoundError",
    "RateLimitError",
    "ServiceError",
    "CloudMeshConnectionError",
]
