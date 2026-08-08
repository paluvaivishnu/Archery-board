"""
schemas.py — Pydantic request/response models for the bullet hole scoring API.
"""

from typing import List, Optional
from pydantic import BaseModel, Field


class BulletScore(BaseModel):
    """One detected bullet hole + its score, ring label, and detector confidence."""
    bullet_id: int = Field(..., description="Stable 0-based bullet index, assigned in detection order")
    x: int = Field(..., description="Bullet hole center X (pixels)")
    y: int = Field(..., description="Bullet hole center Y (pixels)")
    score: float = Field(..., ge=0.0, le=10.99, description="Decimal score 0.00-10.99")
    ring: int = Field(0, ge=0, le=10, description="Integer ring (0-10) the hole landed in")
    confidence: Optional[float] = Field(
        None, ge=0.0, le=1.0,
        description="Detector confidence for this hole (0-1). Low values (<0.5) "
                    "should be flagged for manual review in real-world deployments.",
    )


class ScoreRequest(BaseModel):
    """Optional overrides for the scoring pipeline."""
    conf: float = Field(0.4, ge=0.0, le=1.0, description="Detection confidence threshold")
    weights: str = Field("models/weights/best.pt", description="Path to model weights")


class ScoreResponse(BaseModel):
    """Response payload returned by POST /score."""
    bullets_detected: int
    scores: List[float] = Field(..., description="Per-bullet decimal scores (2 dp)")
    bullets: List[BulletScore] = Field(default_factory=list, description="Detailed per-bullet info")
    total_score: float = Field(..., description="Sum of all bullet scores (2 dp)")
    calibration: Optional[str] = Field(
        None,
        description="Which class the board center was calibrated from: 'black_contour' | 'target_board' | None",
    )
    annotated_image_url: Optional[str] = Field(None, description="Relative URL to download the annotated image")


class HealthResponse(BaseModel):
    status: str
    model: str
    device: str