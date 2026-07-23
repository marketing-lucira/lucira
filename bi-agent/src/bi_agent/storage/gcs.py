"""GCS publisher — writes the dashboard snapshot + archives reports."""
from __future__ import annotations

import json
import logging

log = logging.getLogger(__name__)


class SnapshotStore:
    def __init__(self, bucket: str, project: str | None = None) -> None:
        self.bucket_name = bucket
        self.project = project
        self._bucket = None

    @property
    def bucket(self):
        if self._bucket is None:
            from google.cloud import storage  # lazy import
            self._bucket = storage.Client(project=self.project).bucket(self.bucket_name)
        return self._bucket

    def publish_json(self, path: str, payload: dict) -> str:
        blob = self.bucket.blob(path)
        blob.cache_control = "no-cache"
        blob.upload_from_string(json.dumps(payload, default=str), content_type="application/json")
        log.info("published snapshot gs://%s/%s", self.bucket_name, path)
        return f"https://storage.googleapis.com/{self.bucket_name}/{path}"

    def archive(self, path: str, blob_bytes: bytes, content_type: str) -> str:
        blob = self.bucket.blob(path)
        blob.upload_from_string(blob_bytes, content_type=content_type)
        return f"https://storage.googleapis.com/{self.bucket_name}/{path}"
