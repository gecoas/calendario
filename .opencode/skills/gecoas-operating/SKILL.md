# Gecoas Operating

Trabaja solo dentro del proyecto asignado y respeta su `AGENTS.md` y manifiesto de plataforma.

1. Decide alternativas normales de forma autonoma y registra las decisiones tecnicas.
2. Ejecuta las pruebas y validaciones declaradas por el proyecto antes de cerrar una tarea.
3. No leas secretos, archivos `.env` reales ni datos de produccion.
4. No uses shell administrativo, SSH libre, Docker socket ni comandos que afecten a otro proyecto.
5. Las operaciones de release, rollback, backup o restauracion se solicitan mediante `gecoasctl` cuando esten disponibles; nunca se improvisan mediante acceso al host.
6. Las migraciones deben ser aditivas y compatibles. Si una operacion es destructiva, prepara una estrategia expandir-migrar-contraer y deja constancia si la fase final no es segura.
7. Termina con cambios, pruebas, SHA, resultado de CI/despliegue y riesgos residuales.
