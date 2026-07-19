"""UI preferences endpoint — language persistence across devices."""

from __future__ import annotations

CSRF = {"x-potato-csrf": "1", "origin": "http://testserver"}


def test_language_defaults_to_null(client):
    resp = client.get("/internal/ui-preferences")
    assert resp.status_code == 200
    assert resp.json() == {"language": None}


def test_language_round_trips(client):
    post = client.post("/internal/ui-preferences", json={"language": "es"}, headers=CSRF)
    assert post.status_code == 200
    assert post.json() == {"updated": True, "language": "es"}

    got = client.get("/internal/ui-preferences")
    assert got.status_code == 200
    assert got.json() == {"language": "es"}


def test_language_can_be_updated(client):
    client.post("/internal/ui-preferences", json={"language": "fr"}, headers=CSRF)
    client.post("/internal/ui-preferences", json={"language": "pt-PT"}, headers=CSRF)
    assert client.get("/internal/ui-preferences").json() == {"language": "pt-PT"}


def test_invalid_language_rejected(client):
    resp = client.post("/internal/ui-preferences", json={"language": "not a lang!!"}, headers=CSRF)
    assert resp.status_code == 400
    assert resp.json()["reason"] == "invalid_language"
    # store stays untouched
    assert client.get("/internal/ui-preferences").json() == {"language": None}
