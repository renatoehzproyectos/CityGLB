# Estatuas (Three D Scans)

Coloca aquí GLB ligeros llamados `statue-01.glb` … `statue-06.glb`
(ranuras y posiciones en `src/lib/city/rome.ts`). Los que falten se omiten.

Los scans de https://threedscans.com son de millones de triángulos: decímalos antes
(<= 30k triángulos) y expórtalos a GLB, por ejemplo:

    npx @gltf-transform/cli simplify scan.glb statue-01.glb --ratio 0.02 --error 0.001

Crédito sugerido: "Scan by Oliver Laric, threedscans.com".
