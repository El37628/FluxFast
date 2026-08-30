"""Tests for additive Live Resource wire event models."""

import pytest
from pydantic import TypeAdapter
from pydantic import ValidationError as PydanticValidationError

from fluxfast import (
    LIVE_EVENT_NAME,
    LIVE_RESYNC_REASONS,
    LiveEvent,
    LiveInvalidateEvent,
    LivePatchEvent,
    LiveReadyEvent,
    LiveResyncEvent,
    replace_item,
)


def test_live_event_constants_and_models_serialize_to_v1_wire_shapes():
    assert LIVE_EVENT_NAME == "fluxfast"
    assert LIVE_RESYNC_REASONS == (
        "overflow",
        "reconnect",
        "broker-recovery",
        "server",
    )

    events = [
        LiveReadyEvent(keys=["summary", "activity"]),
        LiveInvalidateEvent(keys=["summary"], originClientId="ff_client_a"),
        LivePatchEvent(
            patches={
                "rooms": [
                    replace_item(101, {"id": 101, "status": "occupied"})
                ]
            },
            originClientId="ff_client_a",
        ),
        LiveResyncEvent(keys=["summary", "activity"], reason="overflow"),
    ]

    dumped = [event.model_dump(mode="json", exclude_none=True) for event in events]
    assert [event["type"] for event in dumped] == [
        "ready",
        "invalidate",
        "patch",
        "resync",
    ]
    assert all(event["protocol"] == "fluxfast/1" for event in dumped)
    assert dumped[2]["patches"]["rooms"][0] == {
        "op": "replace-item",
        "id": 101,
        "value": {"id": 101, "status": "occupied"},
    }


@pytest.mark.parametrize(
    ("payload", "event_type"),
    [
        (
            {"protocol": "fluxfast/1", "type": "ready", "keys": ["summary"]},
            LiveReadyEvent,
        ),
        (
            {
                "protocol": "fluxfast/1",
                "type": "invalidate",
                "keys": ["summary"],
                "originClientId": "ff_client_a",
            },
            LiveInvalidateEvent,
        ),
        (
            {
                "protocol": "fluxfast/1",
                "type": "patch",
                "patches": {"rooms": [{"op": "remove-item", "id": 101}]},
            },
            LivePatchEvent,
        ),
        (
            {
                "protocol": "fluxfast/1",
                "type": "resync",
                "keys": ["summary"],
                "reason": "reconnect",
            },
            LiveResyncEvent,
        ),
    ],
)
def test_live_event_discriminated_union_parses_each_event(payload, event_type):
    event = TypeAdapter(LiveEvent).validate_python(payload)

    assert isinstance(event, event_type)


@pytest.mark.parametrize(
    "payload",
    [
        {"protocol": "fluxfast/2", "type": "ready", "keys": ["summary"]},
        {"protocol": "fluxfast/1", "type": "unknown", "keys": ["summary"]},
        {"protocol": "fluxfast/1", "type": "ready", "keys": [1]},
        {
            "protocol": "fluxfast/1",
            "type": "ready",
            "keys": [f"key-{index}" for index in range(101)],
        },
        {
            "protocol": "fluxfast/1",
            "type": "invalidate",
            "keys": ["summary"],
            "originClientId": "x" * 65,
        },
        {
            "protocol": "fluxfast/1",
            "type": "patch",
            "patches": [],
        },
        {
            "protocol": "fluxfast/1",
            "type": "patch",
            "patches": {"rooms": [{"op": "execute-code"}]},
        },
        {
            "protocol": "fluxfast/1",
            "type": "resync",
            "keys": ["summary"],
            "reason": "replay",
        },
    ],
)
def test_live_event_union_rejects_malformed_wire_data(payload):
    with pytest.raises(PydanticValidationError):
        TypeAdapter(LiveEvent).validate_python(payload)
