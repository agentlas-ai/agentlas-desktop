/* Private test observation only; never packaged or published. SQLite's VFS
 * methods, filenames, flags and SQL remain exact for admitted operations. */
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <string.h>
#include <stdio.h>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#define LIFE_TLS __declspec(thread)
#define life_open _open
#define life_write _write
#define life_sync _commit
#define life_close _close
#else
#include <unistd.h>
#define LIFE_TLS _Thread_local
#define life_open open
#define life_write write
#define life_sync fsync
#define life_close close
#endif
#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef SQLITE_OK_LOAD_PERMANENTLY
#error SQLite permanent extension lifetime is required
#endif

typedef struct LifeVfs LifeVfs;
struct LifeVfs {sqlite3_vfs *vfs; int (*open)(sqlite3_vfs*,sqlite3_filename,sqlite3_file*,int,int*);int (*remove)(sqlite3_vfs*,const char*,int);void *(*dlopen)(sqlite3_vfs*,const char*);LifeVfs *next;};
static LifeVfs *entries;
static LIFE_TLS sqlite3 *observer;
static char *failure_file;
static char *failure_line;
static char *observer_library;
static int native_denials;
static sqlite3_mutex *mutex(void){return sqlite3_mutex_alloc(SQLITE_MUTEX_STATIC_MAIN);}
static LifeVfs *find_entry(sqlite3_vfs *vfs){LifeVfs *entry;sqlite3_mutex_enter(mutex());for(entry=entries;entry&&entry->vfs!=vfs;entry=entry->next){}sqlite3_mutex_leave(mutex());return entry;}
static void native_failure(void){
  const char *line,*file;sqlite3_mutex_enter(mutex());native_denials++;line=failure_line;file=failure_file;sqlite3_mutex_leave(mutex());
  if(file&&line){int fd=life_open(file,O_WRONLY|O_APPEND|O_NOFOLLOW);if(fd>=0){size_t at=0,n=strlen(line);while(at<n){int wrote=(int)life_write(fd,line+at,(unsigned int)(n-at));if(wrote<=0)break;at+=(size_t)wrote;}life_sync(fd);life_close(fd);}}
}
static int admit(const char *file,const char *operation){
  sqlite3_stmt *stmt=0;int rc;
  if(!observer){native_failure();return SQLITE_CANTOPEN;}
  rc=sqlite3_prepare_v2(observer,"SELECT agentlas_gate_file(?1,?2)",-1,&stmt,0);
  if(rc==SQLITE_OK){if(file)sqlite3_bind_text(stmt,1,file,-1,SQLITE_TRANSIENT);else sqlite3_bind_null(stmt,1);sqlite3_bind_text(stmt,2,operation,-1,SQLITE_STATIC);rc=sqlite3_step(stmt);}
  if(stmt)sqlite3_finalize(stmt);
  if(rc!=SQLITE_ROW){native_failure();return SQLITE_CANTOPEN;}
  return SQLITE_OK;
}
static void *observed_dlopen(sqlite3_vfs *vfs,const char *file){LifeVfs *entry=find_entry(vfs);if(!entry||!entry->dlopen||!file||!observer_library||strcmp(file,observer_library)){native_failure();return 0;}return entry->dlopen(vfs,file);}
static int observed_open(sqlite3_vfs *vfs,sqlite3_filename name,sqlite3_file *file,int flags,int *out){
  LifeVfs *entry=find_entry(vfs);if(!entry){native_failure();return SQLITE_CANTOPEN;}
  /* Read-only opens cannot create a database or sidecar. All writable opens,
   * including named VFS aliases and DELETEONCLOSE temp files, are admitted. */
  if(flags&(SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_DELETEONCLOSE)){int rc=admit(name,"xOpen");if(rc!=SQLITE_OK)return rc;}
  return entry->open(vfs,name,file,flags,out);
}
static int observed_delete(sqlite3_vfs *vfs,const char *name,int sync_dir){LifeVfs *entry=find_entry(vfs);if(!entry){native_failure();return SQLITE_IOERR_DELETE;}if(admit(name,"xDelete")!=SQLITE_OK)return SQLITE_IOERR_DELETE;return entry->remove(vfs,name,sync_dir);}
static void status(sqlite3_context *ctx,int argc,sqlite3_value **argv){int value;(void)argc;(void)argv;sqlite3_mutex_enter(mutex());value=native_denials;sqlite3_mutex_leave(mutex());sqlite3_result_int(ctx,value);}
static char *config(sqlite3 *db,const char *sql){sqlite3_stmt *stmt=0;char *copy=0;if(sqlite3_prepare_v2(db,sql,-1,&stmt,0)==SQLITE_OK&&sqlite3_step(stmt)==SQLITE_ROW){const unsigned char *value=sqlite3_column_text(stmt,0);if(value)copy=sqlite3_mprintf("%s",value);}if(stmt)sqlite3_finalize(stmt);return copy;}
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db,char **error,const sqlite3_api_routines *api){
  sqlite3_vfs *vfs;char *event_file,*event_line,*library;int count=0;
  SQLITE_EXTENSION_INIT2(api);
  if(observer&&observer!=db){native_failure();*error=sqlite3_mprintf("gate_life_native_observer_replacement_refused");return SQLITE_ERROR;}
  event_file=config(db,"SELECT agentlas_gate_native_config('file')");event_line=config(db,"SELECT agentlas_gate_native_config('line')");library=config(db,"SELECT agentlas_gate_native_config('library')");
  if(!event_file||!event_line||!library){sqlite3_free(event_file);sqlite3_free(event_line);sqlite3_free(library);*error=sqlite3_mprintf("gate_life_native_config_missing");return SQLITE_ERROR;}
  vfs=sqlite3_vfs_find(0);
  sqlite3_mutex_enter(mutex());
  if(!failure_file){failure_file=event_file;failure_line=event_line;observer_library=library;}else{if(strcmp(failure_file,event_file)||strcmp(observer_library,library)){sqlite3_mutex_leave(mutex());sqlite3_free(event_file);sqlite3_free(event_line);sqlite3_free(library);*error=sqlite3_mprintf("gate_life_native_context_changed");return SQLITE_ERROR;}sqlite3_free(event_file);sqlite3_free(event_line);sqlite3_free(library);}
  for(;vfs;vfs=vfs->pNext){LifeVfs *entry;for(entry=entries;entry&&entry->vfs!=vfs;entry=entry->next){}if(!entry){entry=sqlite3_malloc64(sizeof(*entry));if(!entry){sqlite3_mutex_leave(mutex());return SQLITE_NOMEM;}entry->vfs=vfs;entry->open=vfs->xOpen;entry->remove=vfs->xDelete;entry->dlopen=vfs->xDlOpen;entry->next=entries;entries=entry;vfs->xOpen=observed_open;vfs->xDelete=observed_delete;if(vfs->xDlOpen)vfs->xDlOpen=observed_dlopen;}count++;}
  observer=db;sqlite3_mutex_leave(mutex());
  if(!count){*error=sqlite3_mprintf("gate_life_no_native_vfs");return SQLITE_ERROR;}
  sqlite3_create_function(db,"agentlas_gate_vfs_denials",0,SQLITE_UTF8,0,status,0,0);
  return SQLITE_OK_LOAD_PERMANENTLY;
}
