// KITmate server types — CONVENTIONS §5 のサーバ版 (app/src/types/index.ts と同等の重複定義)

// ===== 課程 =====
export type ProgramId = 'bio' | 'chem' | 'elec' | 'info' | 'mech' | 'design_arch';
export type ChemCourseId = 'A' | 'B' | 'C' | 'D';
export type DesignArchCourseId = 'design' | 'architecture';

export interface ProgramSelection {
  program: ProgramId;
  chemCourse?: ChemCourseId;      // program === 'chem' のとき必須
  daCourse?: DesignArchCourseId;  // program === 'design_arch' のとき必須
  tech: boolean;                  // 地域創生Tech Program
}

// 20変種キー: 'bio' 'bio-tech' 'chem-A' 'chem-A-tech' ... 'da-design' 'da-architecture-tech'
export function programVariantKey(sel: ProgramSelection): string {
  const base =
    sel.program === 'chem' ? `chem-${sel.chemCourse ?? 'A'}` :
    sel.program === 'design_arch' ? `da-${sel.daCourse ?? 'design'}` :
    sel.program;
  return sel.tech ? `${base}-tech` : base;
}

// ===== 科目区分 =====
export type SubjectCategory =
  | 'english'                    // 全学共通: 英語
  | 'liberal_foundation'         // 全学共通: 基盤教養
  | 'liberal_practical'          // 全学共通: 実践教養
  | 'liberal_senior'             // 全学共通: 高年次配当
  | 'intro_required'             // 専門導入(必修)
  | 'intro_elective_required'    // 専門導入(選択必修)
  | 'intro_elective'             // 専門導入(選択)
  | 'basic_required'             // 専門基礎(必修)
  | 'basic_elective_required'    // 専門基礎(選択必修)
  | 'basic_elective'             // 専門基礎(選択)
  | 'program_required'           // 課程専門(必修)
  | 'program_elective_required'  // 課程専門(選択必修)
  | 'program_elective'           // 課程専門(選択)
  | 'program_elective_A'         // デザ建築: 課程専門(選必A)
  | 'program_elective_B'
  | 'program_elective_C'
  | 'program_elective_ABC'
  | 'program_elective_D'
  | 'program_elective_other_course' // 応化: 課程専門(選必・他コース)
  | 'graduation_research'        // 卒業研究・プロジェクト
  | 'other_program'              // 他課程科目
  | 'out_of_scope'               // 要件外
  | 'not_allowed';               // 履修不可

// ===== 学期 =====
export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
export type Period = 1 | 2 | 3 | 4 | 5;
export type Semester = 'first' | 'second';                      // 前学期/後学期
export type Quarter = '1Q' | '2Q' | '3Q' | '4Q';
export type CourseTerm = Semester | Quarter | 'full_year';      // 講義の開講区分

export interface CourseSlot { day: Day; period: Period; }

// ===== 講義 =====
export interface SyllabusPlanItem { round: number; topic: string; content?: string; pre?: string; post?: string; }
export interface SyllabusDetail {
  outline?: string;            // 授業の目的・概要
  prerequisites?: string | null;
  outOfClassStudy?: string;    // 授業時間外学習
  grading?: string;            // 成績評価の方法及び基準
  notes?: string;              // 留意事項等
  goal?: string;               // 学習の到達目標
  plan?: SyllabusPlanItem[];
  materials?: string;          // 教材情報
}
export interface Course {
  id: string;                  // 時間割番号 (一意)
  subjectNumber: string;       // 科目番号
  name: string;                // 授業科目名
  instructors: string[];
  faculty: string;             // 学部等
  offeredThisYear: boolean;    // 今年度開講
  targetGrade: number;         // 年次 (1..4)
  term: CourseTerm;
  slots: CourseSlot[];         // 空配列 = 集中講義
  intensive: boolean;
  credits: number;
  classFormat: string;         // 授業形態
  room?: string;               // 講義室
  classLabel?: string;         // クラス (同名複数クラス時: "Aクラス" 等)
  attributes?: string | null;
  // 入学年度 → 課程変種キー → 科目区分。キーが無ければ 'out_of_scope' 扱い
  categoryByProgram: Record<string, Record<string, SubjectCategory>>;
  syllabus?: SyllabusDetail;
}
export function categoryFor(course: Course, admissionYear: number, variantKey: string): SubjectCategory {
  return course.categoryByProgram[String(admissionYear)]?.[variantKey] ?? 'out_of_scope';
}

// ===== 時間割 =====
export interface CustomCourse {
  name: string;
  instructors?: string[];
  credits: number;
  category: SubjectCategory;
  room?: string;
  memo?: string;
}
export interface TimetableEntry {
  id: string;                  // uuid
  year: number;                // 年度
  term: Semester;
  quarters?: Quarter[];        // クォーター開講分 (例 ['1Q'])。undefined = 学期全体
  day?: Day;                   // undefined = 集中
  period?: Period;
  courseId?: string;           // 公式講義
  custom?: CustomCourse;       // オリジナル講義 (courseId と排他)
  classLabel?: string;
  color?: string;              // セル色 (任意)
}
export interface SharedTimetable {
  version: 1;
  title?: string;
  year: number;
  term: Semester;
  entries: TimetableEntry[];
}

// ===== 要件 =====
export type RequirementKind = 'graduation' | 'research_start';
export interface RequirementSet {
  admissionYear: number;
  variantKey: string;
  kind: RequirementKind;
  minima: Partial<Record<SubjectCategory, number>>;
  groupTotals?: {
    liberalTotal?: number;      // 全学共通科目合計
    basicTotal?: number;        // 専門基礎合計
    specializedTotal?: number;  // 専門教育科目合計
    grandTotal?: number;        // 総合計
  };
}

// ===== 休講情報 =====
export interface LectureNotice {                 // 授業関連連絡
  no: number; facultyLabel: string; termLabel: string; courseName: string;
  instructors: string[]; dayLabel: string; periodLabel: string | null;
  category: string; message: string; firstPostedAt: string; updatedAt: string;
}
export interface CancellationNotice {            // 休講通知
  no: number; facultyLabel: string; courseName: string; instructors: string[];
  cancelledOn: string; dayLabel: string; periodLabel: string; remarks: string; postedAt: string;
}
export interface CancellationFeed { notices: LectureNotice[]; cancellations: CancellationNotice[]; fetchedAt: string; }

// ===== サーバ内部 =====
export interface SyncedTimetable {
  entries: TimetableEntry[];
  updatedAt: number;           // unix ms
}

export type PushPlatform = 'expo' | 'web';

export interface PushRegisterBody {
  platform: PushPlatform;
  token?: string;              // expo push token (platform === 'expo')
  subscription?: object;       // Web Push subscription (platform === 'web')
  cancellationNotifications: boolean;   // 休講通知の購読
  lectureInfoNotifications?: boolean;   // 授業関連連絡の購読 (省略時は休講と同値)
}

export interface PushUnregisterBody {
  platform: PushPlatform;
  token?: string;
  endpoint?: string;
}
