# Defensive patterns

English | [中文](defensive-patterns.zh.md)

Plugin disposal must reach quiescence: request cancellation, await owned work, and remove listeners before late completions can publish. A failed Loader or Include update must leave the last accepted tree active. Callback dispatch must contain one observer's failure so later observers and ownership cleanup still run.

These rules protect lifecycle behavior in the locally modified Cordis fork. Add focused regression coverage before changing them.
