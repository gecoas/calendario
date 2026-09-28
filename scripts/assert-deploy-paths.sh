assert_no_protected_tracked_paths() {
  local source="${1:-}"
  local treeish="${2:-}"
  local tracked_paths_file path protected=false

  tracked_paths_file="$(mktemp)" || {
    printf '%s\n' 'No se pudieron comprobar las rutas protegidas del despliegue' >&2
    return 1
  }

  case "$source" in
    current)
      if ! git ls-files -z > "$tracked_paths_file"; then
        rm -f -- "$tracked_paths_file" >/dev/null 2>&1 || true
        printf '%s\n' 'No se pudieron comprobar las rutas protegidas del despliegue' >&2
        return 1
      fi
      ;;
    target)
      if [[ -z "$treeish" ]] || ! git ls-tree -r --name-only -z "$treeish" > "$tracked_paths_file"; then
        rm -f -- "$tracked_paths_file" >/dev/null 2>&1 || true
        printf '%s\n' 'No se pudieron comprobar las rutas protegidas del despliegue' >&2
        return 1
      fi
      ;;
    *)
      rm -f -- "$tracked_paths_file" >/dev/null 2>&1 || true
      printf '%s\n' 'No se pudieron comprobar las rutas protegidas del despliegue' >&2
      return 1
      ;;
  esac

  while IFS= read -r -d '' path; do
    if [[ "$path" == ".env" || "$path" == .env/* || "$path" == "data" || ( "$path" == data/* && "$path" != "data/.gitkeep" ) ]]; then
      protected=true
    fi
  done < "$tracked_paths_file"

  rm -f -- "$tracked_paths_file" >/dev/null 2>&1 || {
    printf '%s\n' 'No se pudieron comprobar las rutas protegidas del despliegue' >&2
    return 1
  }

  if [[ "$protected" == true ]]; then
    printf '%s\n' 'Se rechaza el despliegue: hay rutas protegidas versionadas' >&2
    return 1
  fi
}
