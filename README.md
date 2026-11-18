# Cámara web — camara.sidios.cl

Versión web de **Cámara**, la app de cámara para macOS (SwiftUI + AVFoundation + Core Image). Corre entera en el navegador: las imágenes se procesan en tu equipo y las capturas se guardan solo en el navegador.

- Sitio estático (HTML/CSS/JS sin build) publicado con GitHub Pages en `https://camara.sidios.cl`.
- Estética de [sidios.cl](https://sidios.cl): estilo Apple, tipografía del sistema (SF Pro), azul `#0071e3` y modo oscuro automático (tokens copiados de `prompt.sidios.cl`).
- Requiere HTTPS (o `localhost`) y un navegador con WebGL 2.

## Funciones

| App macOS | Web |
| --- | --- |
| Visor en vivo, selección de cámara, resolución y fps | `getUserMedia` + `enumerateDevices` |
| Estilos fotográficos y ajustes de imagen (Core Image) | Shaders WebGL 2 en dos pasos (`assets/pipeline.js`) |
| Zoom digital 1/2/3/5× y pellizco (hasta 6×) | Recorte en el shader; pellizco, rueda y teclas |
| Compensación de contraluz con Vision | Detección de caras con MediaPipe (incluido en el repo) + mismas fórmulas en GLSL |
| Fusión de 8 fotogramas | Alineación por traslación en la CPU y promedio en la GPU (`assets/fusion.js`) |
| Foto HEIF/JPEG | JPEG, WebP o PNG |
| Vídeo HEVC/H.264/ProRes con sonido | `MediaRecorder`: MP4 (H.264/HEVC) o WebM según el navegador |
| Temporizador, cuadrícula, histograma, flash de pantalla, sonido | Igual |
| Enfoque y exposición por clic, bloqueo AE/AF, balance de blancos, flash | Solo si el navegador expone esas capacidades (sobre todo Chrome en Android); si no, se avisa |
| Carpeta Imágenes/Cámara y visor | IndexedDB + visor con descarga y compartir |
| Center Stage, efectos de vídeo del sistema, Fotos.app | No existen en la web |

## Estructura

| Archivo | Contenido |
| --- | --- |
| `index.html` | Página: barra, visor, panel de ajustes y visor de capturas |
| `assets/styles.css` | Estilos (tokens de sidios.cl) |
| `assets/app.js` | Estado, interfaz, captura, grabación y atajos |
| `assets/camera.js` | Cámara, formatos y capacidades de hardware |
| `assets/pipeline.js` | Pipeline WebGL 2 (ajustes, estilos, contraluz, nitidez, viñeta, fusión) |
| `assets/backlight.js` | Medición de contraluz y mapa de velo |
| `assets/fusion.js` | Ráfaga, alineación y descarte de fotogramas con movimiento |
| `assets/gallery.js` | Guardado en IndexedDB y visor de capturas |
| `assets/vendor/mediapipe/` | `@mediapipe/tasks-vision` 1.2.2 (Apache-2.0) y el modelo `blaze_face_short_range` |

## Atajos

`Espacio` foto/grabar · `1`/`2` modo · `+`/`−`/`0` zoom · `T` temporizador · `G` cuadrícula · `H` histograma · `L` contraluz · `F` autoenfoque continuo · `S` ajustes · `C` capturas · `Alt`+clic o mantener pulsado: bloqueo AE/AF.

## Desarrollo local

```sh
python3 -m http.server 8000
# abrir http://localhost:8000 (localhost cuenta como contexto seguro para la cámara)
```

## DNS

Cloudflare: registro `CNAME camara → sidios1.github.io` (solo DNS, nube gris).

## Créditos

Detección de caras: [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) de Google, licencia Apache-2.0.
