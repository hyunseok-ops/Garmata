# Novel-view 360 evaluation (docs/PLAN.md Phase 8)

Listing: 2009 Pierce Velocity Pumper #226894 (53800795-ac58-4b41-9e42-25ba4cde098d). SEVA on H100, Splatfacto 7k iterations on A10G, 768x576 frames.

| Version | Inputs | Change | Generated views | 360 result |
| --- | --- | --- | --- | --- |
| v5 | 5 real, all officer side | baseline | Officer side consistent; driver side 30-105° loses the cab and front wheel | Recognizable outline; driver side is a red slab. Rejected. |
| v6 | 7 real (2 driver-side pinned) | photo coverage both sides | 16/17 consistent; 120° a blank red box | Driver side gains cab and wheels; blotchy everywhere. Rejected. |
| v7 | 7 real as conditioning only | all 24 slots generated from exact cameras | All consistent except 120°; size drifts between views | About the same as v6. Rejected. |
| v8 | 7 real, cut out and scaled to the ring's expected size on white | view normalization | 24/24 consistent, steady size | Cab, windows, wheels and stripe hold all the way round; surfaces streaky, rear weakest. Pending review. |
| v9 | as v8 | 48-view ring (7.5°) | running | running |

Findings
- Photo coverage matters most: the first photo per label was always the same side. Facing detection plus pinning fixed it for this listing; a vision-model picker is the robust automation.
- Real photos disagree with fixed cameras (distance/zoom vary up to ~1.4x); training on them directly blurs the splat. View normalization (plan §4) removed most of it.
- Viewer: 95-120 fps orbiting every version.
- Cost per run: ~6 min H100 (SEVA) + ~2 min CPU (matting) + ~3 min A10G (Splatfacto).
