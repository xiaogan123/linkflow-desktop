#!/bin/bash
set -euo pipefail
umask 077

VERSION="__LINKFLOW_VERSION__"
EXPECTED_SHA256="__LINKFLOW_MAC_ARM64_SHA256__"
REPOSITORY="xiaogan123/linkflow-desktop"
APP_NAME="外链助手.app"
BUNDLE_ID="com.linkflow.personal"
DEFAULT_DESTINATION="/Applications"

CURL_BIN="/usr/bin/curl"
SHASUM_BIN="/usr/bin/shasum"
TAR_BIN="/usr/bin/tar"
DITTO_BIN="/usr/bin/ditto"
CODESIGN_BIN="/usr/bin/codesign"
PLUTIL_BIN="/usr/bin/plutil"
LIPO_BIN="/usr/bin/lipo"
XATTR_BIN="/usr/bin/xattr"
GETCONF_BIN="/usr/bin/getconf"
PGREP_BIN="/usr/bin/pgrep"
UNAME_BIN="/usr/bin/uname"
FIND_BIN="/usr/bin/find"
READLINK_BIN="/usr/bin/readlink"
REALPATH_BIN="/bin/realpath"
MKTEMP_BIN="/usr/bin/mktemp"
MV_BIN="/bin/mv"
RM_BIN="/bin/rm"
RMDIR_BIN="/bin/rmdir"
GREP_BIN="/usr/bin/grep"
AWK_BIN="/usr/bin/awk"
STAT_BIN="/usr/bin/stat"
MKDIR_BIN="/bin/mkdir"
PWD_BIN="/bin/pwd"
CAT_BIN="/bin/cat"

fail(){ printf '安装未完成：%s\n' "$1" >&2;exit 1; }
canonical_directory(){ (cd -P -- "$1" >/dev/null 2>&1&&"$PWD_BIN" -P); }

destination="$DEFAULT_DESTINATION"
custom_destination=0
while (($#));do
  case "$1" in
    --destination)
      (($#>=2))||fail '--destination 需要目录参数。'
      ((custom_destination==0))||fail '--destination 只能提供一次。'
      destination="$2";custom_destination=1;shift 2;;
    *) fail '只支持无参数安装，或在隔离测试中使用 --destination。';;
  esac
done

[[ "$VERSION" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]]||fail '安装脚本尚未绑定正式版本。'
[[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]]||fail '安装脚本尚未绑定正式安装包摘要。'
required_tools=("$CURL_BIN" "$SHASUM_BIN" "$TAR_BIN" "$DITTO_BIN" "$CODESIGN_BIN" "$PLUTIL_BIN" "$LIPO_BIN" "$XATTR_BIN" "$GETCONF_BIN" "$PGREP_BIN" "$UNAME_BIN" "$FIND_BIN" "$READLINK_BIN" "$REALPATH_BIN" "$MKTEMP_BIN" "$MV_BIN" "$RM_BIN" "$RMDIR_BIN" "$GREP_BIN" "$AWK_BIN" "$STAT_BIN" "$MKDIR_BIN" "$PWD_BIN" "$CAT_BIN")
for required_tool in "${required_tools[@]}";do
  [[ -x "$required_tool" ]]||fail "缺少 macOS 系统命令 ${required_tool##*/}；安装器不会自动安装依赖。"
done
[[ "$("$UNAME_BIN" -s)" == 'Darwin' ]]||fail '此安装器只能在 macOS 上运行。'
[[ "$("$UNAME_BIN" -m)" == 'arm64' ]]||fail '此安装器只支持 Apple Silicon Mac。'
[[ -d "$destination"&&! -L "$destination" ]]||fail '安装目录不存在或不是普通目录。'

system_temp="$($GETCONF_BIN DARWIN_USER_TEMP_DIR)"||fail '无法读取系统临时目录。'
[[ -d "$system_temp"&&! -L "$system_temp" ]]||fail '系统临时目录不可用。'
system_temp="$(canonical_directory "$system_temp")"||fail '无法确认系统临时目录。'
destination="$(canonical_directory "$destination")"||fail '无法确认安装目录。'
if ((custom_destination));then
  case "$destination/" in "$system_temp/"*) ;; *) fail '--destination 仅允许位于系统临时目录中的隔离测试目录。';; esac
  [[ "${destination##*/}" == 'Applications' ]]||fail '隔离测试目录必须以 Applications 命名。'
else
  [[ "$destination" == "$DEFAULT_DESTINATION" ]]||fail '正式安装位置必须是 /Applications。'
fi
[[ -w "$destination" ]]||fail '当前账号没有安装目录写入权限；请使用系统已有的授权方式后重试。'

cd -P -- "$destination"||fail '无法锁定安装目录。'
destination_identity="$("$STAT_BIN" -f '%d:%i' .)"||fail '无法读取安装目录身份。'
destination_physical="$("$PWD_BIN" -P)"||fail '无法读取安装目录位置。'
[[ "$destination_physical" == "$destination" ]]||fail '安装目录的真实位置与已验证位置不一致。'

destination_path_matches(){
  local current_identity
  [[ -d "$destination"&&! -L "$destination" ]]||return 1
  current_identity="$("$STAT_BIN" -f '%d:%i' "$destination")"||return 1
  [[ "$current_identity" == "$destination_identity" ]]
}

bound_destination_matches(){
  local bound_path="${1:-.}" current_identity current_physical
  current_identity="$("$STAT_BIN" -f '%d:%i' "$bound_path")"||return 1
  current_physical="$(cd -P -- "$bound_path"&&"$PWD_BIN" -P)"||return 1
  [[ "$current_identity" == "$destination_identity"&&"$current_physical" == "$destination" ]]
}

ensure_app_is_not_running(){
  local running_status=1
  if "$PGREP_BIN" -f -- '(^|/)外链助手[.]app/Contents/MacOS/外链助手([[:space:]]|$)' >/dev/null 2>&1;then running_status=0;else running_status=$?;fi
  ((running_status!=0))||fail '外链助手仍在运行。请从应用菜单正常退出后重新执行安装器。'
  ((running_status==1))||fail '无法确认外链助手是否正在运行；安装器未替换应用。'
}

target_app="./$APP_NAME"
[[ ! -L "$target_app" ]]||fail '目标应用路径是符号链接，已拒绝替换。'
[[ ! -e "$target_app"||-d "$target_app" ]]||fail '目标应用路径不是应用目录，已拒绝替换。'
ensure_app_is_not_running

work_root="$($MKTEMP_BIN -d "$system_temp/linkflow-mac-install.XXXXXX")"||fail '无法创建隔离下载目录。'
cleanup(){ local result=$?;cd -P -- "$system_temp" >/dev/null 2>&1||:;case "$work_root/" in "$system_temp"/*) "$RM_BIN" -rf -- "$work_root";; esac;exit "$result"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

archive="$work_root/Linkflow-$VERSION-mac-arm64.zip"
download_url="https://github.com/$REPOSITORY/releases/download/v$VERSION/Linkflow-$VERSION-mac-arm64.zip"
printf '正在从官方 GitHub Release 下载外链助手 %s…\n' "$VERSION"
"$CURL_BIN" --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --output "$archive" "$download_url"||fail '官方下载失败。'
[[ -f "$archive"&&! -L "$archive" ]]||fail '下载结果不是普通文件。'
archive_snapshot_path="$("$MKTEMP_BIN" "$work_root/.archive-snapshot.XXXXXX")"||fail '无法创建安装包快照。'
exec 3<> "$archive_snapshot_path"||fail '无法打开安装包快照。'
exec 4< "$archive_snapshot_path"||fail '无法锁定安装包校验快照。'
exec 5< "$archive_snapshot_path"||fail '无法锁定安装包目录快照。'
exec 6< "$archive_snapshot_path"||fail '无法锁定安装包类型快照。'
exec 7< "$archive_snapshot_path"||fail '无法锁定安装包解包快照。'
exec 9< "$archive_snapshot_path"||fail '无法锁定安装包复核快照。'
"$RM_BIN" -- "$archive_snapshot_path"||fail '无法隐藏安装包快照。'
for snapshot_fd in 3 4 5 6 7 9;do
  [[ "$("$STAT_BIN" -f '%l' "/dev/fd/$snapshot_fd")" == '0' ]]||fail '安装包快照仍有外部文件名，已停止。'
done
"$CAT_BIN" "$archive" >&3||fail '无法复制已下载安装包。'
exec 3>&-
"$RM_BIN" -- "$archive"||fail '无法封存已下载安装包。'
archive_snapshot_identity="$("$STAT_BIN" -f '%d:%i:%z:%l' /dev/fd/4)"||fail '无法读取安装包快照身份。'
case "$archive_snapshot_identity" in *:0) ;; *) fail '安装包快照不是独占文件。';; esac
archive_snapshot_matches(){
  local snapshot_fd current_identity
  for snapshot_fd in 4 5 6 7 9;do
    current_identity="$("$STAT_BIN" -f '%d:%i:%z:%l' "/dev/fd/$snapshot_fd")"||return 1
    [[ "$current_identity" == "$archive_snapshot_identity" ]]||return 1
  done
}
archive_snapshot_matches||fail '安装包快照在校验前发生变化。'
actual_sha256="$("$SHASUM_BIN" -a 256 /dev/fd/4|"$AWK_BIN" '{print $1}')"||fail '无法计算安装包摘要。'
[[ "$actual_sha256" == "$EXPECTED_SHA256" ]]||fail '安装包 SHA-256 与此脚本绑定的正式版本不一致；没有解包或修改任何应用属性。'
archive_snapshot_matches||fail '安装包快照在摘要校验期间发生变化。'

archive_entries="$("$TAR_BIN" -tf /dev/fd/5)"||fail '无法读取安装包目录。'
[[ -n "$archive_entries" ]]||fail '安装包为空。'
while IFS= read -r entry;do
  [[ -n "$entry" ]]||fail '安装包包含空路径。'
  [[ "$entry" != *$'\r'*&&"$entry" != *$'\t'*&&"$entry" != *\\*&&"$entry" != *' -> '* ]]||fail '安装包包含不安全路径字符。'
  safe_entry="${entry%/}"
  case "/$safe_entry/" in *'/../'*|*'/./'*|*'//'*) fail '安装包包含越界路径。';; esac
  case "$safe_entry" in "$APP_NAME"|"$APP_NAME/"*) ;; *) fail '安装包包含应用目录以外的内容。';; esac
done <<< "$archive_entries"

archive_verbose="$("$TAR_BIN" -tvf /dev/fd/6)"||fail '无法读取安装包类型信息。'
while IFS= read -r entry_line;do
  entry_type="${entry_line:0:1}"
  case "$entry_type" in
    -|d) ;;
    l)
      [[ "$entry_line" == *' -> '* ]]||fail '安装包符号链接缺少可信目标。'
      link_target="${entry_line#* -> }"
      [[ -n "$link_target"&&"$link_target" != /*&&"$link_target" != *$'\n'*&&"$link_target" != *$'\r'*&&"$link_target" != *\\* ]]||fail '安装包包含外部符号链接。'
      case "/$link_target/" in *'/../'*|*'/./'*|*'//'*) fail '安装包包含越界符号链接。';; esac;;
    *) fail '安装包包含不支持的链接或特殊文件。';;
  esac
done <<< "$archive_verbose"

extract_root="$work_root/extracted"
"$MKDIR_BIN" -m 700 "$extract_root"||fail '无法创建解包目录。'
"$DITTO_BIN" -x -k --noqtn /dev/fd/7 "$extract_root"||fail '安全解包失败。'
archive_snapshot_matches||fail '安装包快照在解包期间发生变化。'
final_archive_sha256="$("$SHASUM_BIN" -a 256 /dev/fd/9|"$AWK_BIN" '{print $1}')"||fail '无法复核安装包摘要。'
[[ "$final_archive_sha256" == "$EXPECTED_SHA256" ]]||fail '安装包快照在解包期间发生变化。'
archive_snapshot_matches||fail '安装包快照在复核期间发生变化。'
exec 4<&-
exec 5<&-
exec 6<&-
exec 7<&-
exec 9<&-
shopt -s nullglob dotglob
extracted_entries=("$extract_root"/*)
shopt -u nullglob dotglob
staged_app="$extract_root/$APP_NAME"
[[ ${#extracted_entries[@]} -eq 1&&"${extracted_entries[0]}" == "$staged_app"&&-d "$staged_app"&&! -L "$staged_app" ]]||fail '解包结构不是唯一的外链助手应用。'

validate_internal_links(){
  local app="$1" app_root link target resolved
  app_root="$($REALPATH_BIN "$app")"||return 1
  while IFS= read -r -d '' link;do
    target="$($READLINK_BIN "$link")"||return 1
    [[ -n "$target"&&"$target" != /*&&"$target" != *$'\n'*&&"$target" != *$'\r'* ]]||return 1
    case "/$target/" in *'/../'*|*'/./'*|*'//'*) return 1;; esac
    resolved="$($REALPATH_BIN "$link")"||return 1
    case "$resolved" in "$app_root"/*) ;; *) return 1;; esac
  done < <("$FIND_BIN" "$app" -type l -print0)
}

validate_safe_tree(){
  local app="$1" unsafe hardlinked
  unsafe="$("$FIND_BIN" "$app" ! -type f ! -type d ! -type l -print -quit)"||return 1
  [[ -z "$unsafe" ]]||return 1
  hardlinked="$("$FIND_BIN" "$app" \( -type f -o -type l \) -links +1 -print -quit)"||return 1
  [[ -z "$hardlinked" ]]
}

validate_app(){
  local app="$1" plist executable identifier version minimum_system architectures signature
  [[ -d "$app"&&! -L "$app" ]]||return 1
  validate_safe_tree "$app"||return 1
  validate_internal_links "$app"||return 1
  "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1||return 1
  signature="$($CODESIGN_BIN --display --verbose=4 "$app" 2>&1)"||return 1
  printf '%s\n' "$signature"|"$GREP_BIN" -qx 'Signature=adhoc'||return 1
  if printf '%s\n' "$signature"|"$GREP_BIN" -q '^Authority=';then return 1;fi
  plist="$app/Contents/Info.plist";executable="$app/Contents/MacOS/外链助手"
  [[ -f "$plist"&&-f "$executable"&&! -L "$executable" ]]||return 1
  identifier="$($PLUTIL_BIN -extract CFBundleIdentifier raw -o - "$plist")"||return 1
  version="$($PLUTIL_BIN -extract CFBundleShortVersionString raw -o - "$plist")"||return 1
  minimum_system="$($PLUTIL_BIN -extract LSMinimumSystemVersion raw -o - "$plist")"||return 1
  architectures="$($LIPO_BIN -archs "$executable")"||return 1
  [[ "$identifier" == "$BUNDLE_ID"&&"$version" == "$VERSION"&&"$minimum_system" == '14.0'&&"$architectures" == 'arm64' ]]
}

quarantine_present(){
  local attributes
  attributes="$($XATTR_BIN -l -r -s "$1")"||return 2
  printf '%s\n' "$attributes"|"$GREP_BIN" -q 'com\.apple\.quarantine:'
}

validate_app_without_quarantine(){
  local app="$1" status
  validate_app "$app"||return 1
  if quarantine_present "$app";then return 1;else status=$?;fi
  ((status==1))
}

validated_staged_stream(){
  local emit_archive="$1" staged_identity quarantine_result
  cd -P -- "$staged_app"||{ printf '无法锁定已解包应用快照。\n' >&2;return 1; }
  staged_identity="$("$STAT_BIN" -f '%d:%i' .)"||{ printf '无法读取已解包应用身份。\n' >&2;return 1; }
  validate_safe_tree .||{ printf '已解包应用包含特殊文件或指向树外同一文件的硬链接。\n' >&2;return 1; }
  validate_app .||{ printf '应用身份、版本、架构、内部链接或严格代码签名校验失败。\n' >&2;return 1; }
  quarantine_result=1
  if quarantine_present .;then
    printf '新解包应用含来源隔离属性；安装器不会主动删除属性或继续安装。\n' >&2
    return 1
  else quarantine_result=$?;fi
  ((quarantine_result==1))||{ printf '无法确认新应用的扩展属性。\n' >&2;return 1; }
  [[ "$("$STAT_BIN" -f '%d:%i' .)" == "$staged_identity" ]]||{ printf '已解包应用快照在校验期间被替换。\n' >&2;return 1; }
  validate_safe_tree .||{ printf '已验证应用快照在复制前出现了特殊文件或多重硬链接。\n' >&2;return 1; }
  if ((emit_archive));then "$TAR_BIN" -cf - .||return 1;fi
}

(validated_staged_stream 0)||fail '已解包应用未通过安装前校验。'
destination_path_matches&&bound_destination_matches||fail '安装目录在校验期间被换名或替换；未替换任何应用。'
transaction_root="$($MKTEMP_BIN -d './.linkflow-install.XXXXXX')"||fail '无法在已锁定的安装目录创建原子替换事务。'
case "$transaction_root" in ./.linkflow-install.*) ;; *) fail '原子替换事务路径超出已锁定的安装目录。';; esac
[[ "${transaction_root#./}" != */* ]]||fail '原子替换事务路径不是已锁定目录的直接子目录。'
[[ -d "$transaction_root"&&! -L "$transaction_root" ]]||fail '原子替换事务目录在创建后被替换。'
transaction_identity="$("$STAT_BIN" -f '%d:%i' "$transaction_root")"||fail '无法读取原子替换事务身份。'
transaction_name="${transaction_root#./}"
transaction_path="$destination/$transaction_name"
cd -P -- "$transaction_root"||fail '无法锁定原子替换事务目录。'

transaction_path_matches(){
  local current_identity
  [[ -d "$transaction_path"&&! -L "$transaction_path" ]]||return 1
  current_identity="$("$STAT_BIN" -f '%d:%i' "$transaction_path")"||return 1
  [[ "$current_identity" == "$transaction_identity" ]]
}

bound_transaction_matches(){
  local current_identity parent_identity
  current_identity="$("$STAT_BIN" -f '%d:%i' .)"||return 1
  parent_identity="$("$STAT_BIN" -f '%d:%i' ..)"||return 1
  [[ "$current_identity" == "$transaction_identity"&&"$parent_identity" == "$destination_identity" ]]
}

replacement_context_matches(){
  destination_path_matches&&bound_destination_matches ..&&transaction_path_matches&&bound_transaction_matches
}

rollback_parent_matches(){
  destination_path_matches&&bound_destination_matches ..&&bound_transaction_matches
}

guarded_parent_move(){
  local unsafe_message="$1"
  shift
  rollback_parent_matches||fail "$unsafe_message"
  "$MV_BIN" "$@"
}

replacement_context_matches||fail '原子替换事务或安装目录在绑定期间被替换。'
new_app="./$APP_NAME"
previous_app="./previous-$APP_NAME"
rejected_app="./rejected-$APP_NAME"
target_app="../$APP_NAME"
"$MKDIR_BIN" -m 700 "$new_app"||fail '无法在事务目录创建新应用位置。'
if ! (validated_staged_stream 1)|"$TAR_BIN" -xpf - -C "$new_app";then
  fail '无法把已验证应用快照复制到已锁定的安装卷。'
fi
replacement_context_matches||fail '原子替换事务或安装目录在复制期间被换名或替换；未替换任何应用。'
validate_app_without_quarantine "$new_app"||fail '安装卷上的应用副本未通过严格校验，或意外带有来源隔离属性。'

ensure_app_is_not_running
replacement_context_matches||fail '原子替换事务或安装目录在替换前被换名或替换；未替换任何应用。'
[[ ! -L "$target_app" ]]||fail '目标应用路径在下载期间变成符号链接，已拒绝替换。'
[[ ! -e "$target_app"||-d "$target_app" ]]||fail '目标应用路径在下载期间变成非应用目录，已拒绝替换。'

had_previous=0
if [[ -e "$target_app" ]];then
  guarded_parent_move '事务父目录在建立旧应用回滚副本前已变化。' "$target_app" "$previous_app"||fail '无法建立旧应用回滚副本。'
  had_previous=1
fi
if ! replacement_context_matches;then
  if ((had_previous));then
    guarded_parent_move '原子替换事务的父目录已变化；已停止自动回滚，旧应用保留在已绑定的事务中。' "$previous_app" "$target_app"||fail '安装目录身份变化，且旧应用需要手动从事务目录恢复。'
    fail '安装目录在替换期间被换名或替换；旧应用已恢复。'
  fi
  fail '安装目录在替换期间被换名或替换；未安装新应用。'
fi
if ! guarded_parent_move '事务父目录在安装新应用前已变化；已停止替换。' "$new_app" "$target_app";then
  if ((had_previous));then
    guarded_parent_move '新应用替换失败，且事务父目录已变化；已停止自动回滚，旧应用保留在已绑定的事务中。' "$previous_app" "$target_app"||fail '新应用替换失败，且旧应用需要手动从事务目录恢复。'
    fail '新应用替换失败；旧应用已恢复。'
  fi
  fail '新应用替换失败；安装位置保持为空。'
fi
if ! replacement_context_matches||! validate_app_without_quarantine "$target_app"||! replacement_context_matches;then
  guarded_parent_move '安装后校验未完成，且事务父目录已变化；已停止自动隔离和回滚。' "$target_app" "$rejected_app"||fail '安装后校验失败，无法移开新应用。'
  if ((had_previous));then
    guarded_parent_move '新应用已移入已绑定事务，但事务父目录随后变化；已停止自动回滚。' "$previous_app" "$target_app"||fail '安装后校验失败，且旧应用需要手动从事务目录恢复。'
    fail '安装后校验失败；旧应用已恢复。'
  fi
  fail '安装后校验失败；未在安装位置留下未验证应用。'
fi

printf '外链助手 %s 已安装到 %s。\n' "$VERSION" "$destination/$APP_NAME"
printf '用户数据未被读取或修改。请从“应用程序”正常启动。\n'
if ((had_previous));then
  printf '旧应用回滚副本保留在：%s/%s\n' "$transaction_path" "${previous_app#./}"
else
  replacement_context_matches||fail '应用已安装，但原子替换事务目录身份已变化。'
  cd -P -- ..||fail '应用已安装，但无法返回安装目录。'
  bound_destination_matches||fail '应用已安装，但安装目录身份已变化。'
  "$RMDIR_BIN" "./$transaction_name"||fail '应用已安装，但空事务目录未能清理。'
fi
